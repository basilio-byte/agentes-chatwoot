import type { Prisma } from "@/generated/prisma/client";
import { IntegrationProvider, IntegrationStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { diaEmSaoPaulo } from "@/lib/tempo";
import {
  ConexaApiError,
  juntarPaginas,
  type ConexaClient,
} from "@/server/integrations/conexa/client";
import { abrirConexa } from "@/server/integrations/conexa/sistema";
import { lerConfigNotasFiscais, type NotasFiscaisConfig } from "./config";
import {
  categoriaDoProduto,
  classificarItem,
  CONFERIR_A_CADA_MS,
  decidir,
  decisaoDeFora,
  desdeQuando,
  lerCobranca,
  lerVenda,
  motivoParaFicarFora,
  TETO_POR_RODADA,
  type CobrancaLida,
  type Decisao,
  type Evento,
  type ItemClassificado,
} from "./regras";

/**
 * A rodada das notas fiscais, no relógio do vigia (regras em `regras.ts`).
 *
 * MODO SOMBRA: lê o Conexa e grava no NOSSO banco a nota que emitiria. Não
 * chama a Spedy, não escreve no Conexa e não toca no n8n — é o relatório que a
 * equipe confere contra as notas reais antes de qualquer corte.
 *
 * - **Quem procura é o relógio, não o aviso do Conexa.** Lê as cobranças pagas
 *   desde `desdeQuando` e as geradas dos clientes "antes". Quando houver
 *   emissão de verdade, o aviso do Conexa vira só um atalho: esta rodada é o
 *   que garante que cobrança paga sem nota não passa em silêncio.
 * - **Uma linha por cobrança** (`cobrancaId` único): cobrança já vista não é
 *   lida de novo, e duas rodadas ao mesmo tempo não gravam duas vezes.
 * - **Não prende o vigia.** Cada cobrança lê as vendas e o produto de cada uma;
 *   com o Conexa lento, a rodada leva minutos. Ela começa e segue sozinha.
 * - **Falha numa cobrança não grava nada dela**: a rodada seguinte tenta de
 *   novo. Gravar meia leitura classificaria com itens faltando.
 */

let ultimaConferencia = 0;
let rodando = false;

export type RodadaFiscal = {
  acao: "cedo" | "em andamento" | "desligada" | "iniciada" | "conferido";
  vistas?: number;
  novas?: number;
  registradas?: number;
  falhas?: number;
  /** Ficaram para a rodada seguinte por causa de `TETO_POR_RODADA`. */
  pendentes?: number;
  /** A listagem do Conexa parou no teto: pode haver cobrança que não foi vista. */
  incompleta?: boolean;
  erro?: string;
};

/** Chamada pelo vigia a cada minuto; confere de fato a cada `CONFERIR_A_CADA_MS`. */
export async function conferirNotasFiscais(
  agora = new Date(),
  opcoes: { esperar?: boolean; forcar?: boolean } = {},
): Promise<RodadaFiscal> {
  if (rodando) return { acao: "em andamento" };
  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" };
  }

  const linha = await db.integration.findUnique({
    where: { provider: IntegrationProvider.NOTAS_FISCAIS },
    select: { enabled: true, config: true },
  });
  if (!linha?.enabled) return { acao: "desligada" };

  ultimaConferencia = agora.getTime();
  rodando = true;
  const config = lerConfigNotasFiscais(linha.config);
  const rodada = rodar(agora, config)
    .then(async (r) => {
      await registrarRodada(agora, r);
      if (r.registradas || r.falhas || r.erro) logger.info(r, "notas fiscais conferidas (sombra)");
      return r;
    })
    .catch(async (erro: unknown) => {
      logger.error({ erro }, "notas fiscais: a conferência falhou");
      const r: RodadaFiscal = { acao: "conferido", erro: mensagemDe(erro) };
      await registrarRodada(agora, r).catch(() => {});
      return r;
    })
    .finally(() => {
      rodando = false;
    });

  if (opcoes.esperar) return rodada;
  void rodada;
  return { acao: "iniciada" };
}

/** Só para teste: esquece o relógio entre um caso e outro. */
export function reiniciarRelogioDasNotas() {
  ultimaConferencia = 0;
  rodando = false;
}

type Candidata = { cobranca: CobrancaLida; evento: Evento };

async function rodar(agora: Date, config: NotasFiscaisConfig): Promise<RodadaFiscal> {
  const aberto = await abrirConexa("notas-fiscais");
  if ("erro" in aberto) return { acao: "conferido", erro: aberto.erro };
  const { cliente } = aberto;

  const hoje = diaEmSaoPaulo(agora);
  const desde = desdeQuando(hoje, config.inicio);

  const candidatas: Candidata[] = [];
  const pagas = await juntarPaginas(
    (p) => cliente.listarCobrancas({ status: "paid", paymentDateFrom: desde, paymentDateTo: hoje, ...p }),
    { porPagina: 100, teto: 1000 },
  );
  for (const bruta of pagas.itens) {
    const cobranca = lerCobranca(bruta);
    if (cobranca) candidatas.push({ cobranca, evento: "quitada" });
  }

  // Clientes "antes": a nota sai na GERAÇÃO. A API não filtra cobrança por data
  // de criação, então lê as em aberto deles e fica com as geradas na janela.
  let geradasCompletas = true;
  const antes = config.clientes.filter((c) => c.regra === "antes").map((c) => c.clienteId);
  if (antes.length) {
    const geradas = await juntarPaginas(
      (p) => cliente.listarCobrancas({ status: "unpaid", customerId: antes, ...p }),
      { porPagina: 100, teto: 500 },
    );
    geradasCompletas = geradas.completo;
    for (const bruta of geradas.itens) {
      const cobranca = lerCobranca(bruta);
      if (cobranca?.criadaEm && cobranca.criadaEm >= desde) {
        candidatas.push({ cobranca, evento: "gerada" });
      }
    }
  }

  const jaVistas = new Set(
    (
      await db.cobrancaFiscal.findMany({
        where: { cobrancaId: { in: candidatas.map((c) => c.cobranca.id) } },
        select: { cobrancaId: true },
      })
    ).map((l) => l.cobrancaId),
  );
  const novas = candidatas
    .filter((c) => !jaVistas.has(c.cobranca.id))
    // As mais antigas primeiro: com o teto, é a ordem em que esperam menos.
    .sort((a, b) => quando(a).localeCompare(quando(b)) || a.cobranca.id - b.cobranca.id);
  const lote = novas.slice(0, TETO_POR_RODADA);

  // Produto e categoria quase nunca mudam: um cache por rodada poupa o Conexa
  // de ler o mesmo plano para cada cliente que o paga.
  const produtos = new Map<number, { categoriaId: number | null } | null>();
  let registradas = 0;
  let falhas = 0;
  for (const { cobranca, evento } of lote) {
    try {
      const fora = motivoParaFicarFora(cobranca, config, evento);
      const itens = fora ? [] : await lerItens(cliente, cobranca, produtos);
      const decisao = fora ? decisaoDeFora(cobranca, fora) : decidir(cobranca, itens, config, evento);
      await gravar(cobranca, evento, itens, decisao);
      registradas++;
    } catch (erro) {
      if (ehConflitoDeUnique(erro)) continue;
      falhas++;
      logger.warn(
        { cobranca: cobranca.id, erro: mensagemDe(erro) },
        "notas fiscais: cobrança não conferida, tenta na próxima rodada",
      );
    }
  }

  return {
    acao: "conferido",
    vistas: candidatas.length,
    novas: novas.length,
    registradas,
    falhas,
    pendentes: novas.length - lote.length,
    incompleta: !pagas.completo || !geradasCompletas,
  };
}

const quando = (c: Candidata) => c.cobranca.quitadaEm ?? c.cobranca.criadaEm ?? "";

async function lerItens(
  cliente: ConexaClient,
  cobranca: CobrancaLida,
  produtos: Map<number, { categoriaId: number | null } | null>,
): Promise<ItemClassificado[]> {
  const itens: ItemClassificado[] = [];
  for (const vendaId of cobranca.vendasIds) {
    const venda = lerVenda(await cliente.obterVenda(vendaId));
    if (!venda) throw new Error(`a venda ${vendaId} veio sem id`);

    let produto: { categoriaId: number | null } | null = null;
    if (venda.produtoId != null) {
      const guardado = produtos.get(venda.produtoId);
      if (guardado !== undefined) {
        produto = guardado;
      } else {
        produto = await lerProduto(cliente, venda.produtoId);
        produtos.set(venda.produtoId, produto);
      }
    }
    itens.push(classificarItem(venda, produto));
  }
  return itens;
}

/** `null` quando o cadastro responde 404 — é assim que a reserva de sala aparece. */
async function lerProduto(cliente: ConexaClient, id: number) {
  try {
    return { categoriaId: categoriaDoProduto(await cliente.obterProduto(id)) };
  } catch (erro) {
    if (erro instanceof ConexaApiError && erro.status === 404) return null;
    throw erro;
  }
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

async function gravar(
  cobranca: CobrancaLida,
  evento: Evento,
  itens: ItemClassificado[],
  decisao: Decisao,
) {
  await db.cobrancaFiscal.create({
    data: {
      cobrancaId: cobranca.id,
      empresaId: cobranca.empresaId,
      clienteId: cobranca.clienteId,
      evento,
      modo: "sombra",
      quitadaEm: cobranca.quitadaEm,
      valorCentavos: cobranca.valorCentavos,
      situacao: decisao.situacao,
      motivo: decisao.motivo,
      cobranca: json(cobranca),
      itens: json(itens),
      notas: json(decisao.notas),
      observacoes: json(decisao.observacoes),
    },
  });
}

/** Quantos dias de cobranças em sombra a tabela nova refaz ao ser salva. */
const DIAS_RECLASSIFICADOS = 30;

/**
 * Refaz a decisão das cobranças em sombra com a config nova — chamada quando
 * alguém salva a tabela de códigos ou as regras por cliente. Pura sobre o que
 * está gravado, sem chamar o Conexa.
 *
 * ⚠ Cobrança que ficou fora ANTES de os itens serem lidos e que agora entraria
 * é apagada: sem os itens não há o que classificar, e a rodada seguinte a lê de
 * novo (se ainda estiver na janela).
 */
export async function reclassificar(config: NotasFiscaisConfig, agora = new Date()) {
  const desde = new Date(agora.getTime() - DIAS_RECLASSIFICADOS * 86_400_000);
  const linhas = await db.cobrancaFiscal.findMany({
    where: { modo: "sombra", criadaEm: { gte: desde } },
    select: {
      id: true,
      evento: true,
      cobranca: true,
      itens: true,
      situacao: true,
      motivo: true,
      notas: true,
      observacoes: true,
    },
  });

  let mudadas = 0;
  let apagadas = 0;
  for (const linha of linhas) {
    const cobranca = linha.cobranca as unknown as CobrancaLida;
    const itens = linha.itens as unknown as ItemClassificado[];
    const evento = linha.evento as Evento;
    const naoLidos = itens.length === 0 && cobranca.vendasIds.length > 0;
    const fora = motivoParaFicarFora(cobranca, config, evento);

    if (naoLidos && !fora) {
      await db.cobrancaFiscal.delete({ where: { id: linha.id } });
      apagadas++;
      continue;
    }
    const decisao = fora ? decisaoDeFora(cobranca, fora) : decidir(cobranca, itens, config, evento);
    const igual =
      decisao.situacao === linha.situacao &&
      decisao.motivo === linha.motivo &&
      mesmoJson(decisao.notas, linha.notas) &&
      mesmoJson(decisao.observacoes, linha.observacoes);
    if (igual) continue;
    await db.cobrancaFiscal.update({
      where: { id: linha.id },
      data: {
        situacao: decisao.situacao,
        motivo: decisao.motivo,
        notas: json(decisao.notas),
        observacoes: json(decisao.observacoes),
      },
    });
    mudadas++;
  }
  return { mudadas, apagadas };
}

/**
 * ⚠ O Postgres guarda `jsonb` com as chaves REORDENADAS: comparar o texto do que
 * foi gravado com o recém-montado acusa diferença em toda linha, e tudo seria
 * regravado e contado como "refeito" a cada salvamento.
 */
export function mesmoJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(ordenarChaves(a)) === JSON.stringify(ordenarChaves(b));
}

function ordenarChaves(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenarChaves);
  if (valor && typeof valor === "object") {
    return Object.fromEntries(
      Object.entries(valor as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, ordenarChaves(v)]),
    );
  }
  return valor;
}

function ehConflitoDeUnique(erro: unknown) {
  return (
    typeof erro === "object" &&
    erro !== null &&
    "code" in erro &&
    (erro as { code?: string }).code === "P2002"
  );
}

function mensagemDe(erro: unknown) {
  return (erro instanceof Error ? erro.message : String(erro)).slice(0, 200);
}

async function registrarRodada(agora: Date, r: RodadaFiscal) {
  const problemas = [
    r.erro,
    r.falhas ? `${r.falhas} cobrança(s) não lida(s) — tenta de novo na próxima` : null,
    r.incompleta ? "a lista do Conexa parou no teto: pode haver cobrança não vista" : null,
  ].filter(Boolean);
  await db.integration.update({
    where: { provider: IntegrationProvider.NOTAS_FISCAIS },
    data: {
      lastCheckedAt: agora,
      status: r.erro ? IntegrationStatus.ERROR : IntegrationStatus.OK,
      lastError: problemas.length ? problemas.join("; ") : null,
    },
  });
}
