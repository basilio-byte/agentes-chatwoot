import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { diaEmSaoPaulo } from "@/lib/tempo";
import { dentroDoHorario } from "@/server/cobranca/regras";
import type { ClickUpClient } from "@/server/integrations/clickup/client";
import { camposDaTarefa } from "@/server/integrations/clickup/campos-da-tarefa";
import { abrirClickUp } from "@/server/integrations/clickup/sistema";
import type { ClickUpTarefa } from "@/server/integrations/clickup/tipos";
import type { ConexaClient } from "@/server/integrations/conexa/client";
import { abrirConexa } from "@/server/integrations/conexa/sistema";

import { LISTA_BASE_DE_CLIENTES, PAGINAS_MAXIMAS } from "./clickup";
import { configDaRenovacao } from "./config";
import { contratoDaLeva } from "./conexa";
import {
  chaveDoFechamento,
  comentarioDaTrava,
  comentarioDoFechamento,
  destinoDoCiclo,
  lerCobrancasPagas,
  pagouOCicloNovo,
} from "./fechamento";
import { DIAS_PARA_PROPAGAR } from "./propagacao";
import { PROVIDER_RENOVACAO, STATUS_PG_PENDENTE } from "./regras";

/**
 * A rodada que fecha o ciclo quando o cliente paga — fase 4. As regras, e o
 * porquê de cada guarda, estão em `fechamento.ts`.
 *
 * ⚠⚠ **Nasce desligada** (`fecharNoPagamento`): `ongoing` faz o ClickUp mandar o
 * e-mail de "cliente renovado" e chamar o webhook de datas. Desligada, a rodada
 * é a leitura de uma configuração.
 *
 * ⚠ **O Conexa limita a 60 requisições por minuto, e os agentes usam o mesmo
 * limite.** Por isso a rodada olha poucos clientes por vez, em rodízio (o que
 * foi conferido há menos de `REVISITAR_APOS_MS` espera), pausa entre as idas e
 * agrupa por cliente: quem tem quatro contratos paga uma fatura só, e as
 * cobranças e vendas lidas servem aos quatro.
 *
 * ⚠ **Quem decide que o ciclo fechou é o dado do Conexa, nunca o texto de
 * ninguém**, e a tarefa só entra na conta se uma reserva de propagação a nomeou:
 * o sistema só fecha o que ele mesmo reajustou.
 */

export const CONFERIR_A_CADA_MS = 30 * 60_000;
export const CLIENTES_POR_RODADA = 5;
export const FECHAMENTOS_POR_RODADA = 10;
/** Quem foi conferido há menos que isto espera a vez dos outros. */
export const REVISITAR_APOS_MS = 3 * 60 * 60_000;
/** Vendas lidas por cliente para amarrar a cobrança ao contrato. */
export const VENDAS_POR_CLIENTE = 8;
export const CHAVE_DA_RODADA = "pagamento";

/** Ajustável só pelo teste: as automações do ClickUp rodam ~2 s depois da troca. */
export const ajustes = { esperaDasAutomacoesMs: 5000, pausaEntreIdasMs: 500 };

let ultimaConferencia = 0;
let rodando = false;
const conferidoEm = new Map<number, number>();

type ClienteClickUp = Pick<
  ClickUpClient,
  "listarTarefasDaLista" | "obterTarefa" | "atualizarTarefa" | "comentarTarefa"
>;
type ClienteConexa = Pick<ConexaClient, "obterContrato" | "listarCobrancas" | "obterVenda">;

export type RodadaDeFechamento = {
  acao:
    | "cedo"
    | "em andamento"
    | "fora do horário"
    | "desligada"
    | "sem clickup"
    | "sem conexa"
    | "nada a fechar"
    | "conferido";
  motivo?: string;
  candidatos?: number;
  fechadas?: string[];
  /** O que a rodada olhou e NÃO fechou, com o motivo. */
  pendentes?: string[];
};

type Candidato = { tarefaId: string; contratoId: number; reajusteEm: string };

/**
 * As tarefas que uma reserva de propagação nomeou, com o contrato e a data do
 * reajuste. Pura: recebe as linhas.
 */
export function candidatosDoFechamento(
  eventos: Array<{ externalId: string; resultado: string | null; detalhe?: string | null }>,
): Candidato[] {
  const achados = new Map<string, Candidato>();
  for (const e of eventos) {
    if (!["propagado", "propagado em parte", "já estava em dia"].includes(e.resultado ?? "")) continue;
    const [, contrato, data] = e.externalId.split(":");
    const tarefaId = e.detalhe ? /"tarefaId":"([^"]+)"/.exec(e.detalhe)?.[1] : undefined;
    const contratoId = Number(contrato);
    if (!tarefaId || !Number.isFinite(contratoId) || !/^\d{4}-\d{2}-\d{2}$/.test(data ?? "")) continue;
    achados.set(`${contratoId}:${data}`, { tarefaId, contratoId, reajusteEm: data });
  }
  return [...achados.values()];
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fecharCiclosPagos(
  opcoes: { forcar?: boolean } = {},
  agora = new Date(),
): Promise<RodadaDeFechamento> {
  if (rodando) return { acao: "em andamento" };

  const config = await configDaRenovacao();
  if (!config.fecharNoPagamento) return { acao: "desligada" };

  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" };
  }
  if (!opcoes.forcar && !dentroDoHorario(agora)) return { acao: "fora do horário" };
  rodando = true;
  ultimaConferencia = agora.getTime();

  try {
    // 1. Só o banco: quem a propagação reajustou e ainda não fechou.
    const desde = new Date(agora.getTime() - DIAS_PARA_PROPAGAR * 86_400_000);
    const eventos = await db.webhookEvent.findMany({
      where: {
        provider: PROVIDER_RENOVACAO,
        externalId: { startsWith: "reajuste:" },
        createdAt: { gte: desde },
      },
      select: { externalId: true, resultado: true, detalhe: true },
    });
    let candidatos = candidatosDoFechamento(eventos);
    if (!candidatos.length) return { acao: "nada a fechar" };

    const jaFechados = await db.webhookEvent.findMany({
      where: {
        provider: PROVIDER_RENOVACAO,
        externalId: { in: candidatos.map((c) => chaveDoFechamento(c.contratoId, c.reajusteEm)) },
      },
      select: { externalId: true },
    });
    const fechados = new Set(jaFechados.map((e) => e.externalId));
    candidatos = candidatos.filter((c) => !fechados.has(chaveDoFechamento(c.contratoId, c.reajusteEm)));
    if (!candidatos.length) return { acao: "nada a fechar" };

    // 2. ClickUp: das nomeadas, as que estão em `pg pendente`.
    const clickup = await abrirClickUp("fechamento da renovação");
    if ("erro" in clickup) return { acao: "sem clickup", motivo: clickup.erro };
    const cliente = clickup.cliente as ClienteClickUp;

    const emPendente: ClickUpTarefa[] = [];
    for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina++) {
      const { tasks } = await cliente.listarTarefasDaLista(LISTA_BASE_DE_CLIENTES, {
        statuses: [STATUS_PG_PENDENTE],
        page: pagina,
      });
      emPendente.push(...tasks);
      if (tasks.length < 100) break;
    }
    const porId = new Map(emPendente.map((t) => [t.id, t]));
    const alvos = candidatos.filter((c) => porId.has(c.tarefaId));
    if (!alvos.length) return { acao: "nada a fechar" };

    // 3. Conexa, em rodízio: os clientes conferidos há mais tempo primeiro.
    //    O cliente de cada contrato vem do nosso retrato (só o banco): ler o
    //    contrato no Conexa para descobrir o cliente custaria uma ida por
    //    candidato, e o teto de clientes por rodada precisa valer ANTES das idas.
    const retratos = await db.retratoDeRenovacao.findMany({
      where: { contratoId: { in: alvos.map((a) => a.contratoId) } },
      select: { contratoId: true, clienteId: true },
    });
    const clienteDe = new Map(retratos.map((r) => [r.contratoId, r.clienteId]));

    const conexa = await abrirConexa("fechamento da renovação");
    if ("erro" in conexa) return { acao: "sem conexa", motivo: conexa.erro, candidatos: alvos.length };
    const leitor = conexa.cliente as ClienteConexa;

    const fechadas: string[] = [];
    const pendentes: string[] = [];

    const conferiveis = alvos.filter((a) => {
      if (!clienteDe.has(a.contratoId)) {
        pendentes.push(`${porId.get(a.tarefaId)?.name}: o contrato ${a.contratoId} não está no retrato — sem como saber o cliente`);
        return false;
      }
      return agora.getTime() - (conferidoEm.get(a.contratoId) ?? 0) >= REVISITAR_APOS_MS;
    });
    const quando = (clienteId: number) =>
      Math.min(...conferiveis.filter((a) => clienteDe.get(a.contratoId) === clienteId).map((a) => conferidoEm.get(a.contratoId) ?? 0));
    const clientes = [...new Set(conferiveis.map((a) => clienteDe.get(a.contratoId) as number))]
      .sort((a, b) => quando(a) - quando(b))
      .slice(0, CLIENTES_POR_RODADA);

    const vendas = new Map<number, number | null>();
    let vendasLidas = 0;

    for (const clienteId of clientes) {
      if (fechadas.length >= FECHAMENTOS_POR_RODADA) break;
      const doCliente = conferiveis.filter((a) => clienteDe.get(a.contratoId) === clienteId);

      // Os contratos de AGORA: o valor do reajuste e se ainda estão ativos.
      const contratos = new Map<number, NonNullable<ReturnType<typeof contratoDaLeva>>>();
      for (const alvo of doCliente) {
        conferidoEm.set(alvo.contratoId, agora.getTime());
        try {
          const lido = contratoDaLeva(await leitor.obterContrato(alvo.contratoId));
          if (!lido || lido.valor == null) {
            pendentes.push(`${porId.get(alvo.tarefaId)?.name}: o Conexa não devolveu o valor do contrato ${alvo.contratoId}`);
          } else if (!lido.ativo) {
            pendentes.push(`${porId.get(alvo.tarefaId)?.name}: o contrato ${alvo.contratoId} não está mais ativo`);
          } else {
            contratos.set(alvo.contratoId, lido);
          }
        } catch (erro) {
          pendentes.push(`${porId.get(alvo.tarefaId)?.name}: não consegui ler o contrato ${alvo.contratoId} — ${(erro as Error).message}`);
        }
        await esperar(ajustes.pausaEntreIdasMs);
      }
      if (!contratos.size) continue;

      const menorReajuste = doCliente.map((c) => c.reajusteEm).sort()[0];
      let pagas;
      try {
        const { itens } = await leitor.listarCobrancas({
          customerId: clienteId,
          status: "paid",
          paymentDateFrom: menorReajuste,
          limit: 50,
        });
        pagas = lerCobrancasPagas(itens);
      } catch (erro) {
        pendentes.push(`cliente ${clienteId}: não consegui ler as cobranças — ${(erro as Error).message}`);
        continue;
      }
      await esperar(ajustes.pausaEntreIdasMs);

      // Amarra cada venda ao contrato dela (uma ida por venda, com teto).
      let lidasDoCliente = 0;
      for (const c of pagas) {
        for (const v of c.vendas) {
          if (vendas.has(v) || lidasDoCliente >= VENDAS_POR_CLIENTE) continue;
          lidasDoCliente++;
          vendasLidas++;
          try {
            const bruta = (await leitor.obterVenda(v)) as Record<string, unknown>;
            const id = Number(bruta.contractId);
            vendas.set(v, Number.isFinite(id) && id > 0 ? id : null);
          } catch {
            // Venda que não abre não amarra nada.
          }
          await esperar(ajustes.pausaEntreIdasMs);
        }
      }

      for (const alvo of doCliente) {
        const contrato = contratos.get(alvo.contratoId);
        if (!contrato || contrato.valor == null) continue;
        const tarefa = porId.get(alvo.tarefaId) as ClickUpTarefa;

        const vendasDoContrato = new Set(
          [...vendas.entries()].filter(([, c]) => c === alvo.contratoId).map(([v]) => v),
        );
        const conferencia = pagouOCicloNovo({
          reajusteEm: alvo.reajusteEm,
          valorDoContrato: contrato.valor,
          cobrancas: pagas,
          vendasDoContrato,
        });
        // Não ter pago ainda é o caso normal, não é pendência.
        if (!conferencia.pagou) continue;

        const resultado = await fecharUma(cliente, tarefa, alvo, contrato.valor, conferencia.evidencia);
        if (resultado.fechada) fechadas.push(tarefa.name);
        else if (resultado.motivo) pendentes.push(`${tarefa.name}: ${resultado.motivo}`);
      }
    }

    const rodada: RodadaDeFechamento = {
      acao: "conferido",
      candidatos: alvos.length,
      fechadas,
      pendentes,
    };
    logger.debug({ vendasLidas, clientes: clientes.length }, "fechamento da renovação: custo da rodada");
    await registrarRodada(agora, fechadas.length ? "fechado" : "nada fechado", rodada);
    return rodada;
  } catch (erro) {
    logger.error({ erro }, "fechamento da renovação falhou");
    await registrarRodada(agora, "falhou", { erro: (erro as Error).message });
    throw erro;
  } finally {
    rodando = false;
  }
}

async function fecharUma(
  cliente: ClienteClickUp,
  tarefa: ClickUpTarefa,
  alvo: Candidato,
  valorDoContrato: number,
  evidencia: { cobrancaId: number; pagaEm: string; valorPago: number },
): Promise<{ fechada: boolean; motivo?: string }> {
  const campos = camposDaTarefa(tarefa);
  const categoria = typeof campos["CATEGORIA DE SERVIÇO"] === "string" ? campos["CATEGORIA DE SERVIÇO"] : null;
  const destino = destinoDoCiclo(categoria);
  if (!destino) {
    return {
      fechada: false,
      motivo: `o cliente pagou (cobrança ${evidencia.cobrancaId}), mas a categoria "${categoria}" renova para um status que o sistema não deduz — mova à mão`,
    };
  }

  const chave = chaveDoFechamento(alvo.contratoId, alvo.reajusteEm);
  let reservaId: string;
  try {
    reservaId = (
      await db.webhookEvent.create({
        data: {
          provider: PROVIDER_RENOVACAO,
          externalId: chave,
          eventType: "pagamento",
          payload: {},
          resultado: "reservado",
        },
        select: { id: true },
      })
    ).id;
  } catch {
    return { fechada: false };
  }
  const desfazer = () => db.webhookEvent.delete({ where: { id: reservaId } }).catch(() => {});

  try {
    // Ao vivo: a pessoa pode ter movido a tarefa agora há pouco.
    const viva = await cliente.obterTarefa(tarefa.id);
    if ((viva.status?.status ?? "").trim().toLowerCase() !== STATUS_PG_PENDENTE) {
      await desfazer();
      return { fechada: false, motivo: `já não estava em "${STATUS_PG_PENDENTE}" ao conferir` };
    }
    await cliente.atualizarTarefa(tarefa.id, { status: destino });
  } catch (erro) {
    await desfazer();
    return { fechada: false, motivo: `o ClickUp recusou a troca — ${(erro as Error).message}` };
  }

  // ⚠ Confere se o status FICOU: uma trava da lista pode devolver a tarefa
  // segundos depois (foi o que o "Contrato Assinado" vazio fez em 11/11/2026).
  await esperar(ajustes.esperaDasAutomacoesMs);
  let ficou = true;
  try {
    const depois = await cliente.obterTarefa(tarefa.id);
    ficou = (depois.status?.status ?? "").trim().toLowerCase() === destino;
  } catch {
    // Sem como conferir, não se afirma que foi devolvida.
  }

  await db.webhookEvent
    .update({
      where: { id: reservaId },
      data: {
        resultado: ficou ? "fechada" : "devolvida",
        detalhe: JSON.stringify({ tarefaId: tarefa.id, contratoId: alvo.contratoId, destino, ...evidencia }),
        processedAt: new Date(),
      },
    })
    .catch((erro) => logger.error({ erro }, "não consegui fechar a reserva do pagamento"));

  await cliente
    .comentarTarefa(
      tarefa.id,
      ficou ? comentarioDoFechamento(destino, evidencia, valorDoContrato) : comentarioDaTrava(destino),
    )
    .catch((erro) => logger.error({ erro, tarefa: tarefa.id }, "fechamento: o comentário não saiu"));

  return ficou
    ? { fechada: true }
    : { fechada: false, motivo: `o ClickUp devolveu a tarefa de "${destino}" — provavelmente uma trava da lista` };
}

async function registrarRodada(agora: Date, resultado: string, detalhe: unknown) {
  try {
    const externalId = `${CHAVE_DA_RODADA}:${diaEmSaoPaulo(agora)}`;
    const dados = {
      resultado,
      detalhe: JSON.stringify(detalhe).slice(0, 2000),
      processedAt: agora,
    };
    await db.webhookEvent.upsert({
      where: { provider_externalId: { provider: PROVIDER_RENOVACAO, externalId } },
      create: {
        provider: PROVIDER_RENOVACAO,
        externalId,
        eventType: "pagamento-rodada",
        payload: {},
        ...dados,
      },
      update: dados,
    });
  } catch (erro) {
    logger.error({ erro }, "não consegui registrar o desfecho do fechamento");
  }
}
