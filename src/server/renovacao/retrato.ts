import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { diaEmSaoPaulo } from "@/lib/tempo";
import { abrirConexa } from "@/server/integrations/conexa/sistema";

import { lerContratosAtivos } from "./conexa";
import { atrasados, daLeva, type ContratoDaLeva } from "./regras";

/**
 * A rodada que tira o RETRATO da leva — o que garante a coluna "Valor
 * Anterior" da planilha.
 *
 * O Conexa não guarda o valor de antes do reajuste: o lote mensal sobrescreve
 * o `amount` e o valor antigo some. Esta rodada lê os contratos ativos uma vez
 * por dia e guarda o valor de cada um **enquanto o lote daquela leva ainda não
 * aconteceu**.
 *
 * ⚠ **Atualiza até o lote, e congela nele.** Guardar só a primeira leitura
 * daria um valor de meses atrás, que alguém pode ter renegociado no meio. Por
 * isso a linha é REESCRITA a cada rodada enquanto o reajuste do contrato for o
 * mesmo que o retrato viu, e para de ser tocada no instante em que o reajuste
 * muda — aí o que está guardado é exatamente o valor da véspera do lote.
 *
 * ⚠ **Só as levas dos próximos meses.** O lote de uma leva acontece por volta
 * do dia 20 do mês ANTERIOR ao da fidelidade (medido: 20/01 para a leva de
 * fevereiro, 21/09 para a de outubro, 23/10 para a de novembro). Três meses de
 * janela cobrem isso com folga e limitam a escrita a algumas centenas de
 * linhas por dia, em vez das ~1.300 de toda a base.
 */

/** Quantas levas à frente (incluindo o mês corrente) entram no retrato. */
export const MESES_DE_RETRATO = 3;

/** Uma vez por dia basta: o lote é mensal. */
export const CONFERIR_A_CADA_MS = 24 * 60 * 60_000;

/**
 * Depois de uma falha, espera isto antes de tentar de novo.
 *
 * ⚠ Não é zero. O vigia bate de minuto em minuto; zerar o relógio na falha
 * faria a rodada refazer ~28 idas ao Conexa a cada 60 s, indefinidamente.
 */
export const ESPERA_APOS_FALHA_MS = 30 * 60_000;

/** Onde o desfecho de cada rodada fica — é por aqui que se vê o que aconteceu. */
export const PROVIDER_RODADA = "RENOVACAO";

let ultimaConferencia = 0;
let rodando = false;

export type RodadaDeRetrato = {
  acao: "cedo" | "em andamento" | "sem conexa" | "conferido";
  motivo?: string;
  levas?: string[];
  contratos?: number;
  novos?: number;
  atualizados?: number;
  congelados?: number;
  leituraCompleta?: boolean;
  erroDaLeitura?: string;
  paginasLidas?: number;
  contratosAtivosLidos?: number;
  erro?: string;
};

/** Os meses `AAAA-MM` do retrato, a partir do dia de hoje em São Paulo. */
export function levasDoRetrato(hoje: string, meses = MESES_DE_RETRATO) {
  const [ano, mes] = hoje.split("-").map(Number);
  return Array.from({ length: meses }, (_, i) => {
    const d = new Date(Date.UTC(ano, mes - 1 + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

export function centavos(valor: number) {
  return Math.round(valor * 100);
}

export type RetratoGravado = { reajusteEm: string | null; valorCentavos: number };
export type DecisaoDoRetrato = "criar" | "atualizar" | "congelar" | "manter";

/**
 * O que fazer com o retrato deste contrato — a regra, pura.
 *
 * - **criar**: ainda não há retrato desta leva.
 * - **congelar**: o reajuste mudou desde o retrato, ou seja, o lote passou.
 *   O valor guardado é o da véspera e **não pode ser tocado** — é ele o "valor
 *   anterior".
 * - **atualizar**: o lote ainda não veio e o valor mudou (renegociação,
 *   correção da equipe). Guardar o mais recente de antes do lote é o certo.
 * - **manter**: nada mudou.
 */
export function decidirRetrato(
  contrato: { valor: number; reajusteEm: string | null },
  existente: RetratoGravado | null,
): DecisaoDoRetrato {
  if (!existente) return "criar";
  if (existente.reajusteEm !== contrato.reajusteEm) return "congelar";
  return existente.valorCentavos === centavos(contrato.valor) ? "manter" : "atualizar";
}

export async function tirarRetratoDaLeva(
  forcar = false,
  agora = new Date(),
): Promise<RodadaDeRetrato> {
  if (rodando) return { acao: "em andamento" };
  if (!forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" };
  }
  rodando = true;
  ultimaConferencia = agora.getTime();

  try {
    const conexa = await abrirConexa("retrato da renovação");
    if ("erro" in conexa) return { acao: "sem conexa", motivo: conexa.erro };

    const leitura = await lerContratosAtivos(conexa.cliente);
    const levas = levasDoRetrato(diaEmSaoPaulo(agora));

    // As levas dos próximos meses MAIS os que já venceram: o atraso é o que a
    // equipe mais precisa ver, e sem gravá-los a tela não teria de onde tirá-los
    // (ela não abre mais o Conexa).
    const porContrato = new Map<number, ContratoDaLeva>();
    for (const leva of levas) {
      for (const c of daLeva(leitura.contratos, leva)) porContrato.set(c.id, c);
    }
    for (const c of atrasados(leitura.contratos, diaEmSaoPaulo(agora))) {
      porContrato.set(c.id, c);
    }
    const alvo = [...porContrato.values()];

    let novos = 0;
    let atualizados = 0;
    let congelados = 0;

    for (const c of alvo) {
      if (c.valor == null || !c.fidelidade) continue;
      const leva = c.fidelidade.slice(0, 7);

      const existente = await db.retratoDeRenovacao.findUnique({
        where: { leva_contratoId: { leva, contratoId: c.id } },
        select: { id: true, reajusteDoRetrato: true, valorCentavos: true },
      });

      const decisao = decidirRetrato(
        { valor: c.valor, reajusteEm: c.reajusteEm },
        existente && { reajusteEm: existente.reajusteDoRetrato, valorCentavos: existente.valorCentavos },
      );

      // O estado de AGORA é reescrito em toda rodada: é o que a tela lê, e é
      // por isso que ela não precisa abrir o Conexa.
      const estadoAtual = {
        clienteId: c.clienteId,
        valorAtualCentavos: centavos(c.valor),
        fidelidade: c.fidelidade,
        periodicidade: c.periodicidade,
        plano: c.resumo ?? null,
        reajusteEm: c.reajusteEm,
        reajustePct: c.reajustePct,
        reajusteIndice: c.reajusteIndice,
        lidoEm: agora,
      };

      // O valor CONGELADO só é tocado enquanto o lote daquela leva não veio.
      const anterior =
        decisao === "criar" || decisao === "atualizar"
          ? { valorCentavos: centavos(c.valor), reajusteDoRetrato: c.reajusteEm }
          : {};

      await db.retratoDeRenovacao.upsert({
        where: { leva_contratoId: { leva, contratoId: c.id } },
        create: { leva, contratoId: c.id, ...estadoAtual, ...anterior, valorCentavos: centavos(c.valor) },
        update: { ...estadoAtual, ...anterior },
      });

      if (decisao === "criar") novos++;
      else if (decisao === "atualizar") atualizados++;
      else if (decisao === "congelar") congelados++;
    }

    const rodada: RodadaDeRetrato = {
      acao: "conferido",
      levas,
      contratos: alvo.length,
      novos,
      atualizados,
      congelados,
      leituraCompleta: leitura.completa,
      erroDaLeitura: leitura.erro,
      paginasLidas: leitura.paginas,
      contratosAtivosLidos: leitura.contratos.length,
    };
    await registrarRodada(agora, leitura.completa ? "conferido" : "incompleto", rodada);
    return rodada;
  } catch (erro) {
    logger.error({ erro }, "retrato da renovação falhou");
    await registrarRodada(agora, "falhou", { erro: (erro as Error).message });
    // Tenta de novo em meia hora, não no minuto seguinte: a leitura é cara.
    ultimaConferencia = agora.getTime() - CONFERIR_A_CADA_MS + ESPERA_APOS_FALHA_MS;
    throw erro;
  } finally {
    rodando = false;
  }
}

/**
 * Deixa o desfecho da rodada gravado em `WebhookEvent`, uma linha por dia.
 *
 * ⚠ **Sem isto a rodada é silêncio.** Em 10/11/2026 ela não gravou nada e a
 * única pista era o log do contêiner, que não se lê daqui — o sintoma foi uma
 * tela vazia sem explicação. Nunca lança: registrar o desfecho não pode
 * derrubar a rodada.
 */
async function registrarRodada(agora: Date, resultado: string, detalhe: unknown) {
  try {
    const dia = diaEmSaoPaulo(agora);
    await db.webhookEvent.upsert({
      where: {
        provider_externalId: { provider: PROVIDER_RODADA, externalId: `rodada:${dia}` },
      },
      create: {
        provider: PROVIDER_RODADA,
        externalId: `rodada:${dia}`,
        eventType: "retrato",
        payload: {},
        resultado,
        detalhe: JSON.stringify(detalhe).slice(0, 2000),
        processedAt: agora,
      },
      update: {
        resultado,
        detalhe: JSON.stringify(detalhe).slice(0, 2000),
        processedAt: agora,
      },
    });
  } catch (erro) {
    logger.error({ erro }, "não consegui registrar o desfecho do retrato");
  }
}

/** O desfecho das últimas rodadas, para a tela e para o MCP. */
export async function ultimasRodadas(limite = 5) {
  return db.webhookEvent.findMany({
    where: { provider: PROVIDER_RODADA, externalId: { startsWith: "rodada:" } },
    select: { externalId: true, resultado: true, detalhe: true, processedAt: true },
    orderBy: { createdAt: "desc" },
    take: limite,
  });
}
