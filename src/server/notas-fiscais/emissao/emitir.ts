import { IntegrationProvider, SituacaoDaNota } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { diaEmSaoPaulo } from "@/lib/tempo";
import { abrirConexa } from "@/server/integrations/conexa/sistema";
import {
  chaveDaSpedy,
  ehRecusaDefinitiva,
  SpedyApiError,
  SpedyClient,
  SpedyRedeError,
  type NotaDaSpedy,
} from "@/server/integrations/spedy/client";
import { createHash } from "node:crypto";
import { configuracaoDeEmail, enviarEmail } from "@/server/integrations/resend/client";
import { lerConfigNotasFiscais, type NotasFiscaisConfig } from "../config";
import type { NotaPlanejada } from "../regras";
import { consultarCep } from "./cep";
import {
  divergenciaDeValor,
  lerTomador,
  motivoParaPausar,
  vagasNaCautela,
  montarCorpo,
  montarAviso,
  motivoDaRecusa,
  podeEmitir,
  problemasDoTomador,
  situacaoDoStatus,
  type CepLido,
  type NotaComProblema,
  type Tomador,
} from "./regras";

/**
 * A emissão das notas na Spedy.
 *
 * ⚠ **Nasce desligada e restrita** (`emissao` na config): sem a chave geral
 * ligada, sem lista de cobranças liberadas ou dia de corte, e sem a chave da
 * Spedy no servidor, nada sai. Não existe sandbox: cada nota é fiscal.
 *
 * - **Reserva antes de enviar.** A linha `NotaFiscalEmitida` nasce RESERVADA
 *   (chave única) antes da primeira chamada. Duas rodadas, ou um reinício no
 *   meio, não mandam a mesma nota duas vezes — e a Spedy ainda recusa pelo
 *   `integrationId`.
 * - **Tentativa anotada ANTES do envio.** Se o processo cai depois do POST e
 *   antes de gravar a resposta, a rodada seguinte sabe que pode ter saído e
 *   procura a nota pelo identificador antes de mandar de novo.
 * - **Erro de rede e 5xx = INCERTA, nunca "não saiu".** Recusa 4xx = FALHOU:
 *   repetir igual dá no mesmo, e uma pessoa precisa corrigir.
 * - **Cadastro ruim não gasta número**: CEP que não existe ou é de outra cidade,
 *   documento sem 11/14 dígitos, nome vazio. Fica FALHOU com "Cadastro do
 *   cliente: …", e é relido a cada rodada — corrigiu no Conexa, a nota sai.
 * - **Nada cancela e nada apaga.** O cliente da Spedy nem tem esses métodos.
 */

const A_CADA_MS = 5 * 60_000;
/** Notas novas por rodada. A Spedy aguenta 5/s; o limite protege o Conexa (60/min). */
const NOVAS_POR_RODADA = 10;
const ACOMPANHADAS_POR_RODADA = 50;
const PAUSA_ENTRE_ENVIOS_MS = 1_000;
const PREFIXO_DE_CADASTRO = "Cadastro do cliente:";
/** Linha que só existe para barrar a nota em dobro de cobrança que o n8n já emitiu. */
export const MARCA_DO_N8N = "emitida pelo n8n";

export type LinhaDaNota = {
  chave: string;
  cobrancaId: number;
  empresa: string;
  codigo: string;
  valorCentavos: number;
  competencia: string | null;
  situacao: SituacaoDaNota;
  spedyId: string | null;
  numero: number | null;
  motivo: string | null;
  tentativas: number;
  enviadaEm: Date | null;
};

export type Repositorio = {
  obter(chave: string): Promise<LinhaDaNota | null>;
  /** `false` quando a chave já existe: quem perdeu a corrida não manda. */
  criar(linha: Omit<LinhaDaNota, "spedyId" | "numero" | "motivo" | "tentativas" | "enviadaEm">): Promise<boolean>;
  atualizar(chave: string, dados: Partial<Omit<LinhaDaNota, "chave">>): Promise<void>;
  aAcompanhar(limite: number): Promise<LinhaDaNota[]>;
  /** Rejeitadas e com falha que ainda não foram levadas a uma pessoa. */
  aAvisar(limite: number): Promise<LinhaDaNota[]>;
  marcarAvisadas(chaves: string[], quando: Date): Promise<void>;
  /** Notas NOSSAS autorizadas (as que o n8n já tinha emitido não contam). */
  contarAutorizadas(): Promise<number>;
  /** Enviadas à Spedy e ainda sem resposta da prefeitura. */
  contarEmVoo(): Promise<number>;
};

export type ResultadoDoAviso = "enviado" | "sem provedor" | "falhou";

export type SpedyDaEmpresa = Pick<SpedyClient, "criarNota" | "obterNota" | "buscarPorIntegrationId">;

export type Dependencias = {
  repo: Repositorio;
  /** `null` quando a chave da empresa não está no servidor. */
  spedy: (empresa: string) => SpedyDaEmpresa | null;
  /** `null` quando a leitura do cliente falhou (não é um problema do cadastro). */
  tomador: (clienteId: number) => Promise<Tomador | null>;
  cep: (cep: string) => Promise<CepLido>;
  agora: () => Date;
  /** Leva o problema a uma pessoa. `sem provedor`: falta a Resend no servidor. */
  avisar: (notas: NotaComProblema[], destinos: string[]) => Promise<ResultadoDoAviso>;
  /**
   * Onde o envio e o acompanhamento anotam o que deve fazer a rodada desligar a
   * emissão (rejeição, recusa da Spedy, valor diferente). A rodada esvazia e lê.
   */
  alertas?: string[];
  /** Desliga a emissão e guarda o motivo à vista na tela. */
  desligar?: (motivo: string) => Promise<void>;
  /** As cobranças prontas, na ordem de chegada. Sem isso, lê do banco. */
  prontas?: () => Promise<LinhaPronta[]>;
};

export type LinhaPronta = {
  cobrancaId: number;
  empresaId: number;
  clienteId: number;
  situacao: string;
  quitadaEm: string | null;
  cobranca: unknown;
  notas: unknown;
};

export type ResultadoDoEnvio =
  | "enviada"
  | "falhou"
  | "incerta"
  | "adiada"
  | "sem chave"
  | "ja existe";

/** Pode tentar de novo sem pergunta: nunca saiu, saiu e não sabemos, ou o cadastro era o problema. */
function reenviavel(l: LinhaDaNota): boolean {
  if (l.situacao === SituacaoDaNota.RESERVADA || l.situacao === SituacaoDaNota.INCERTA) return true;
  return l.situacao === SituacaoDaNota.FALHOU && !!l.motivo?.startsWith(PREFIXO_DE_CADASTRO);
}

export async function enviarNota(
  dep: Dependencias,
  args: {
    nota: NotaPlanejada;
    cobrancaId: number;
    clienteId: number;
    empresa: string;
    enviarEmailAoCliente: boolean;
  },
): Promise<ResultadoDoEnvio> {
  const { nota, empresa } = args;
  const existente = await dep.repo.obter(nota.chave);
  if (existente && !reenviavel(existente)) return "ja existe";

  const spedy = dep.spedy(empresa);
  if (!spedy) return "sem chave";

  const tomador = await dep.tomador(args.clienteId);
  if (!tomador) return "adiada";

  const cep = await dep.cep(tomador.cep);
  const problemas = problemasDoTomador(tomador, cep);
  if (problemas.length) {
    const motivo = `${PREFIXO_DE_CADASTRO} ${problemas.join("; ")}`.slice(0, 500);
    if (existente) {
      if (existente.motivo !== motivo || existente.situacao !== SituacaoDaNota.FALHOU) {
        await dep.repo.atualizar(nota.chave, { situacao: SituacaoDaNota.FALHOU, motivo });
      }
    } else {
      await dep.repo.criar(reserva(args));
      await dep.repo.atualizar(nota.chave, { situacao: SituacaoDaNota.FALHOU, motivo });
    }
    return "falhou";
  }

  if (!existente) {
    const criada = await dep.repo.criar(reserva(args));
    if (!criada) return "ja existe";
  }

  const jaTentou = (existente?.tentativas ?? 0) > 0 || existente?.situacao === SituacaoDaNota.INCERTA;
  const agora = dep.agora();
  await dep.repo.atualizar(nota.chave, {
    situacao: SituacaoDaNota.RESERVADA,
    motivo: null,
    tentativas: (existente?.tentativas ?? 0) + 1,
    enviadaEm: agora,
  });

  try {
    if (jaTentou) {
      const achada = await spedy.buscarPorIntegrationId(nota.chave);
      if (achada) {
        await aplicar(dep, nota.chave, achada, { cobrancaId: args.cobrancaId, valorCentavos: nota.valorCentavos });
        return "enviada";
      }
    }
    const corpo = montarCorpo({
      nota,
      tomador,
      cep,
      hoje: diaEmSaoPaulo(agora),
      enviarEmailAoCliente: args.enviarEmailAoCliente,
    });
    const criada = await spedy.criarNota(corpo);
    await aplicar(dep, nota.chave, criada, { cobrancaId: args.cobrancaId, valorCentavos: nota.valorCentavos });
    return "enviada";
  } catch (erro) {
    if (ehRecusaDefinitiva(erro)) {
      await dep.repo.atualizar(nota.chave, { situacao: SituacaoDaNota.FALHOU, motivo: erro.message.slice(0, 500) });
      dep.alertas?.push(`cobrança ${args.cobrancaId}: a Spedy recusou a nota (${erro.message.slice(0, 120)})`);
      return "falhou";
    }
    if (erro instanceof SpedyApiError && (erro.status === 429 || erro.status === 408)) {
      // "Tente depois": não saiu. Volta para reservada, sem contar como incerta.
      await dep.repo.atualizar(nota.chave, { situacao: SituacaoDaNota.RESERVADA });
      return "adiada";
    }
    // Rede, prazo ou 5xx: pode ter saído.
    const detalhe = erro instanceof SpedyRedeError || erro instanceof SpedyApiError ? erro.message : String(erro);
    await dep.repo.atualizar(nota.chave, {
      situacao: SituacaoDaNota.INCERTA,
      motivo: `o envio não teve resposta (${detalhe.slice(0, 200)}); a próxima rodada procura a nota antes de mandar de novo`,
    });
    return "incerta";
  }
}

function reserva(a: { nota: NotaPlanejada; cobrancaId: number; empresa: string }) {
  return {
    chave: a.nota.chave,
    cobrancaId: a.cobrancaId,
    empresa: a.empresa,
    codigo: a.nota.codigo,
    valorCentavos: a.nota.valorCentavos,
    competencia: a.nota.competencia ?? null,
    situacao: SituacaoDaNota.RESERVADA,
  };
}

/** O que a Spedy disse sobre a nota, na nossa linha. */
async function aplicar(
  dep: Dependencias,
  chave: string,
  nota: NotaDaSpedy,
  esperado: { cobrancaId: number; valorCentavos: number },
) {
  const situacao = situacaoDoStatus(nota.status);
  const motivo = situacao === "REJEITADA" ? motivoDaRecusa(nota.processingDetail) : null;
  await dep.repo.atualizar(chave, {
    situacao: SituacaoDaNota[situacao],
    spedyId: nota.id || null,
    numero: nota.number,
    motivo,
  });
  if (situacao === "REJEITADA") {
    dep.alertas?.push(`cobrança ${esperado.cobrancaId}: rejeitada pela prefeitura (${(motivo ?? "sem motivo").slice(0, 120)})`);
  }
  const divergencia = divergenciaDeValor({
    cobrancaId: esperado.cobrancaId,
    valorCentavos: esperado.valorCentavos,
    valorNaSpedy: nota.amount,
  });
  if (divergencia) dep.alertas?.push(divergencia);
  if (situacao === "AUTORIZADA") {
    // Fica no log para conferir a data: nas notas do n8n `effectiveDate` == `issuedOn`.
    logger.info(
      { chave, cobrancaId: esperado.cobrancaId, numero: nota.number, valor: nota.amount, competencia: nota.effectiveDate, emitidaEm: nota.issuedOn },
      "notas fiscais: nota autorizada",
    );
  }
}

export type Acompanhamento = { autorizadas: number; rejeitadas: number; naFila: number; falhas: number };

/** Pergunta à Spedy como estão as notas que ainda não terminaram. */
export async function acompanharNotas(dep: Dependencias): Promise<Acompanhamento> {
  const r: Acompanhamento = { autorizadas: 0, rejeitadas: 0, naFila: 0, falhas: 0 };
  for (const linha of await dep.repo.aAcompanhar(ACOMPANHADAS_POR_RODADA)) {
    const spedy = dep.spedy(linha.empresa);
    if (!spedy) continue;
    try {
      const nota = linha.spedyId
        ? await spedy.obterNota(linha.spedyId)
        : await spedy.buscarPorIntegrationId(linha.chave);
      if (!nota) {
        r.naFila++;
        continue;
      }
      await aplicar(dep, linha.chave, nota, { cobrancaId: linha.cobrancaId, valorCentavos: linha.valorCentavos });
      const s = situacaoDoStatus(nota.status);
      if (s === "AUTORIZADA") r.autorizadas++;
      else if (s === "REJEITADA") r.rejeitadas++;
      else r.naFila++;
    } catch (erro) {
      r.falhas++;
      logger.warn({ chave: linha.chave, erro: mensagemDe(erro) }, "notas fiscais: não consegui ler a nota na Spedy");
    }
  }
  return r;
}

export type Aviso = { avisadas: number; pendentes: number; motivo?: string };

/**
 * Leva à equipe, num e-mail só, o que deu errado e ainda não foi dito a
 * ninguém. ⚠ Só marca como avisada se a Resend ACEITOU: aviso que não saiu
 * continua pendente e tenta de novo na rodada seguinte — um problema fiscal
 * que ninguém leu é pior que um e-mail repetido.
 */
export async function avisarProblemas(dep: Dependencias, destinos: string[]): Promise<Aviso> {
  const pendentes = await dep.repo.aAvisar(20);
  if (!pendentes.length) return { avisadas: 0, pendentes: 0 };
  if (!destinos.length) return { avisadas: 0, pendentes: pendentes.length, motivo: "sem destinatário na tela" };

  const notas: NotaComProblema[] = pendentes.map((l) => ({
    chave: l.chave,
    cobrancaId: l.cobrancaId,
    empresa: l.empresa,
    codigo: l.codigo,
    valorCentavos: l.valorCentavos,
    situacao: l.situacao === SituacaoDaNota.REJEITADA ? "REJEITADA" : "FALHOU",
    motivo: l.motivo,
  }));
  const resultado = await dep.avisar(notas, destinos);
  if (resultado !== "enviado") return { avisadas: 0, pendentes: pendentes.length, motivo: resultado };
  await dep.repo.marcarAvisadas(pendentes.map((l) => l.chave), dep.agora());
  return { avisadas: pendentes.length, pendentes: 0 };
}

// ---------------------------------------------------------------------------
// A rodada (no relógio do vigia)
// ---------------------------------------------------------------------------

export type RodadaDeEmissao = {
  acao: "cedo" | "em andamento" | "desligada" | "emitido";
  enviadas?: number;
  falhas?: number;
  incertas?: number;
  adiadas?: number;
  semChave?: string[];
  acompanhamento?: Acompanhamento;
  aviso?: Aviso;
  erro?: string;
  /** Por que a emissão foi DESLIGADA nesta rodada. */
  pausada?: string;
  /** Há uma nota esperando a prefeitura (cautela): a seguinte só sai depois. */
  aguardando?: boolean;
};

let ultima = 0;
let rodando = false;

export async function emitirNotasFiscais(
  agora = new Date(),
  opcoes: { forcar?: boolean; dependencias?: Dependencias; config?: NotasFiscaisConfig; pausar?: (ms: number) => Promise<void> } = {},
): Promise<RodadaDeEmissao> {
  if (rodando) return { acao: "em andamento" };
  if (!opcoes.forcar && agora.getTime() - ultima < A_CADA_MS) return { acao: "cedo" };
  // Antes de ler a linha: desligada, a próxima olhada é só daqui a 5 minutos.
  ultima = agora.getTime();

  let config = opcoes.config;
  if (!config) {
    const linha = await db.integration.findUnique({
      where: { provider: IntegrationProvider.NOTAS_FISCAIS },
      select: { enabled: true, config: true },
    });
    if (!linha?.enabled) return { acao: "desligada" };
    config = lerConfigNotasFiscais(linha.config);
  }

  rodando = true;
  try {
    const dep = opcoes.dependencias ?? dependenciasReais();
    return await rodarEmissao(dep, config, opcoes.pausar ?? pausa);
  } catch (erro) {
    logger.error({ erro: mensagemDe(erro) }, "notas fiscais: a emissão falhou");
    return { acao: "emitido", erro: mensagemDe(erro) };
  } finally {
    rodando = false;
  }
}

/** Só para teste. */
export function reiniciarRelogioDaEmissao() {
  ultima = 0;
  rodando = false;
}

/** Depois de enviar na cautela, dá um instante à prefeitura antes de conferir. */
const ESPERA_DA_CONFERENCIA_MS = 3_000;

export async function rodarEmissao(
  dep: Dependencias,
  config: NotasFiscaisConfig,
  pausar: (ms: number) => Promise<void>,
): Promise<RodadaDeEmissao> {
  const r: RodadaDeEmissao = { acao: "emitido", enviadas: 0, falhas: 0, incertas: 0, adiadas: 0, semChave: [] };
  const alertas: string[] = [];
  dep.alertas = alertas;
  const cautela = config.emissao.cautela;

  // Acompanhar vale mesmo com a emissão desligada: nota que já saiu precisa
  // terminar de ser lida, e ler não escreve nada na Spedy.
  r.acompanhamento = await acompanharNotas(dep);
  if (!config.emissao.ligada) {
    r.aviso = await avisarSemLancar(dep, config);
    return r;
  }

  /** Se há motivo para parar, desliga a emissão e diz por quê. */
  const deveParar = async (): Promise<boolean> => {
    if (!alertas.length) return false;
    const autorizadas = cautela > 0 ? await dep.repo.contarAutorizadas() : 0;
    const motivo = motivoParaPausar({ emCautela: cautela > 0 && autorizadas < cautela, problemas: alertas });
    if (!motivo) return false;
    r.pausada = motivo;
    logger.error({ motivo }, "notas fiscais: emissão DESLIGADA sozinha");
    try {
      await dep.desligar?.(motivo);
    } catch (erro) {
      logger.error({ erro: mensagemDe(erro) }, "notas fiscais: não consegui gravar o desligamento");
    }
    return true;
  };

  // O que a conferência das notas já enviadas achou vale ANTES de mandar mais.
  if (await deveParar()) {
    r.aviso = await avisarSemLancar(dep, config);
    return r;
  }

  const prontas = await (dep.prontas ? dep.prontas() : prontasDoBanco());

  let novas = 0;
  let parar = false;
  for (const linha of prontas) {
    if (parar || novas >= NOVAS_POR_RODADA) break;
    const cobranca = linha.cobranca as { criadaEm?: string | null } | null;
    const referencia = linha.quitadaEm ?? cobranca?.criadaEm ?? null;
    const pode = podeEmitir(config, {
      cobrancaId: linha.cobrancaId,
      empresaId: linha.empresaId,
      situacao: linha.situacao,
      referencia,
    });
    if (!pode.ok) continue;
    const empresa = config.empresas[String(linha.empresaId)];

    for (const nota of linha.notas as unknown as NotaPlanejada[]) {
      if (novas >= NOVAS_POR_RODADA) break;
      const existente = await dep.repo.obter(nota.chave);
      if (existente && !reenviavel(existente)) continue;

      // Cautela: uma por vez, e a próxima só depois de a anterior terminar.
      let vagas = Number.POSITIVE_INFINITY;
      if (cautela > 0) {
        vagas = vagasNaCautela({
          cautela,
          autorizadas: await dep.repo.contarAutorizadas(),
          emVoo: await dep.repo.contarEmVoo(),
        });
        if (vagas < 1) {
          r.aguardando = true;
          parar = true;
          break;
        }
      }

      const resultado = await enviarNota(dep, {
        nota,
        cobrancaId: linha.cobrancaId,
        clienteId: linha.clienteId,
        empresa,
        enviarEmailAoCliente: config.emissao.enviarEmailAoCliente,
      });
      if (resultado === "ja existe") continue;
      novas++;
      if (resultado === "enviada") r.enviadas = (r.enviadas ?? 0) + 1;
      else if (resultado === "falhou") r.falhas = (r.falhas ?? 0) + 1;
      else if (resultado === "incerta") r.incertas = (r.incertas ?? 0) + 1;
      else if (resultado === "adiada") r.adiadas = (r.adiadas ?? 0) + 1;
      else if (resultado === "sem chave" && !r.semChave?.includes(empresa)) r.semChave?.push(empresa);

      if (resultado === "enviada") {
        if (Number.isFinite(vagas)) {
          // Na cautela, confere já: é a conferência que libera a próxima nota.
          await pausar(ESPERA_DA_CONFERENCIA_MS);
          somar(r.acompanhamento, await acompanharNotas(dep));
        } else {
          await pausar(PAUSA_ENTRE_ENVIOS_MS);
        }
      }
      if (await deveParar()) {
        parar = true;
        break;
      }
    }
  }
  r.aviso = await avisarSemLancar(dep, config);
  if (r.enviadas || r.falhas || r.incertas || r.semChave?.length || r.aviso.avisadas || r.pausada) {
    logger.info(r, "notas fiscais: rodada de emissão");
  }
  return r;
}

function somar(a: Acompanhamento | undefined, b: Acompanhamento) {
  if (!a) return;
  a.autorizadas += b.autorizadas;
  a.rejeitadas += b.rejeitadas;
  a.naFila += b.naFila;
  a.falhas += b.falhas;
}

async function prontasDoBanco(): Promise<LinhaPronta[]> {
  return db.cobrancaFiscal.findMany({
    where: { situacao: "PRONTA" },
    orderBy: { criadaEm: "asc" },
    take: 200,
    select: { cobrancaId: true, empresaId: true, clienteId: true, situacao: true, quitadaEm: true, cobranca: true, notas: true },
  });
}

/** Falha no aviso nunca derruba a rodada: o problema fica pendente e volta na próxima. */
async function avisarSemLancar(dep: Dependencias, config: NotasFiscaisConfig): Promise<Aviso> {
  try {
    return await avisarProblemas(dep, config.emissao.emailsDeAviso);
  } catch (erro) {
    logger.warn({ erro: mensagemDe(erro) }, "notas fiscais: o aviso à equipe falhou");
    return { avisadas: 0, pendentes: 0, motivo: "falhou" };
  }
}

const pausa = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const mensagemDe = (erro: unknown) => (erro instanceof Error ? erro.message : String(erro)).slice(0, 200);

// ---------------------------------------------------------------------------
// As dependências de verdade
// ---------------------------------------------------------------------------

export function repositorioReal(): Repositorio {
  const ler = (l: {
    chave: string; cobrancaId: number; empresa: string; codigo: string; valorCentavos: number;
    competencia: string | null; situacao: SituacaoDaNota; spedyId: string | null; numero: number | null;
    motivo: string | null; tentativas: number; enviadaEm: Date | null;
  }): LinhaDaNota => ({ ...l });
  return {
    async obter(chave) {
      const l = await db.notaFiscalEmitida.findUnique({ where: { chave } });
      return l ? ler(l) : null;
    },
    async criar(linha) {
      try {
        await db.notaFiscalEmitida.create({ data: linha });
        return true;
      } catch (erro) {
        if ((erro as { code?: string }).code === "P2002") return false;
        throw erro;
      }
    },
    async atualizar(chave, dados) {
      await db.notaFiscalEmitida.update({ where: { chave }, data: { ...dados, verificadaEm: new Date() } });
    },
    async aAvisar(limite) {
      const linhas = await db.notaFiscalEmitida.findMany({
        where: { situacao: { in: [SituacaoDaNota.REJEITADA, SituacaoDaNota.FALHOU] }, avisadaEm: null },
        orderBy: { atualizadaEm: "asc" },
        take: limite,
      });
      return linhas.map(ler);
    },
    async marcarAvisadas(chaves, quando) {
      await db.notaFiscalEmitida.updateMany({ where: { chave: { in: chaves } }, data: { avisadaEm: quando } });
    },
    async contarAutorizadas() {
      return db.notaFiscalEmitida.count({
        where: {
          situacao: SituacaoDaNota.AUTORIZADA,
          // As que o n8n já tinha emitido entram na tabela só para barrar o duplicado.
          NOT: { motivo: { startsWith: MARCA_DO_N8N } },
        },
      });
    },
    async contarEmVoo() {
      return db.notaFiscalEmitida.count({
        where: { situacao: { in: [SituacaoDaNota.ENVIADA, SituacaoDaNota.INCERTA] } },
      });
    },
    async aAcompanhar(limite) {
      const linhas = await db.notaFiscalEmitida.findMany({
        where: { situacao: { in: [SituacaoDaNota.ENVIADA, SituacaoDaNota.INCERTA] } },
        orderBy: { atualizadaEm: "asc" },
        take: limite,
      });
      return linhas.map(ler);
    },
  };
}

export function dependenciasReais(): Dependencias {
  const clientes = new Map<string, SpedyClient>();
  const tomadores = new Map<number, Tomador | null>();
  return {
    repo: repositorioReal(),
    spedy(empresa) {
      const guardado = clientes.get(empresa);
      if (guardado) return guardado;
      const chave = chaveDaSpedy(empresa);
      if (!chave) return null;
      const novo = new SpedyClient(chave);
      clientes.set(empresa, novo);
      return novo;
    },
    async tomador(clienteId) {
      if (tomadores.has(clienteId)) return tomadores.get(clienteId) ?? null;
      try {
        const conexa = await abrirConexa("notas-fiscais");
        if ("erro" in conexa) return null;
        const t = lerTomador((await conexa.cliente.obterCliente(clienteId)) as Record<string, unknown>);
        tomadores.set(clienteId, t);
        return t;
      } catch (erro) {
        logger.warn({ clienteId, erro: mensagemDe(erro) }, "notas fiscais: cliente não lido no Conexa");
        return null;
      }
    },
    cep: (cep) => consultarCep(cep),
    agora: () => new Date(),
    desligar: desligarEmissao,
    async avisar(notas, destinos) {
      const email = configuracaoDeEmail();
      if (!email) return "sem provedor";
      const aviso = montarAviso(notas);
      // Mesma lista = mesma chave: um reenvio depois de timeout não duplica.
      const idempotencia = `nfse-aviso-${createHash("sha256").update(notas.map((n) => n.chave).sort().join("|")).digest("hex").slice(0, 40)}`;
      try {
        await enviarEmail(email, { para: destinos, assunto: aviso.assunto, texto: aviso.texto, html: aviso.html, idempotencia });
        return "enviado";
      } catch (erro) {
        logger.warn({ erro: mensagemDe(erro) }, "notas fiscais: o e-mail de aviso não saiu");
        return "falhou";
      }
    },
  };
}

/**
 * Desliga a emissão e deixa o motivo à vista na tela. Mexe só em `ligada` e
 * `pausadaMotivo`: o resto da config fica exatamente como estava.
 */
async function desligarEmissao(motivo: string): Promise<void> {
  const provider = IntegrationProvider.NOTAS_FISCAIS;
  const linha = await db.integration.findUnique({ where: { provider }, select: { config: true } });
  const config = (linha?.config ?? {}) as Record<string, unknown>;
  const emissao = (config.emissao ?? {}) as Record<string, unknown>;
  const quando = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date());
  const novo = { ...config, emissao: { ...emissao, ligada: false, pausadaMotivo: `${quando} — ${motivo}`.slice(0, 500) } };
  await db.integration.update({ where: { provider }, data: { config: novo as unknown as Prisma.InputJsonValue } });
}
