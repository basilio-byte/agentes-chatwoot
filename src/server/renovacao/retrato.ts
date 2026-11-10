import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { diaEmSaoPaulo } from "@/lib/tempo";
import { abrirConexa } from "@/server/integrations/conexa/sistema";

import { lerContratosAtivos } from "./conexa";
import { daLeva, type ContratoDaLeva } from "./regras";

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

    const alvo: ContratoDaLeva[] = [];
    for (const leva of levas) alvo.push(...daLeva(leitura.contratos, leva));

    let novos = 0;
    let atualizados = 0;
    let congelados = 0;

    for (const c of alvo) {
      if (c.valor == null || !c.fidelidade) continue;
      const leva = c.fidelidade.slice(0, 7);

      const existente = await db.retratoDeRenovacao.findUnique({
        where: { leva_contratoId: { leva, contratoId: c.id } },
        select: { id: true, reajusteEm: true, valorCentavos: true },
      });

      const decisao = decidirRetrato({ valor: c.valor, reajusteEm: c.reajusteEm }, existente);

      if (decisao === "criar") {
        await db.retratoDeRenovacao.create({
          data: {
            leva,
            contratoId: c.id,
            clienteId: c.clienteId,
            valorCentavos: centavos(c.valor),
            fidelidade: c.fidelidade,
            periodicidade: c.periodicidade,
            reajusteEm: c.reajusteEm,
          },
        });
        novos++;
      } else if (decisao === "congelar") {
        congelados++;
      } else if (decisao === "atualizar") {
        await db.retratoDeRenovacao.update({
          where: { id: existente!.id },
          data: { valorCentavos: centavos(c.valor), fidelidade: c.fidelidade },
        });
        atualizados++;
      }
    }

    return {
      acao: "conferido",
      levas,
      contratos: alvo.length,
      novos,
      atualizados,
      congelados,
      leituraCompleta: leitura.completa,
    };
  } catch (erro) {
    logger.error({ erro }, "retrato da renovação falhou");
    // A próxima rodada tenta de novo: deixar o relógio zerado faria a falha de
    // uma leitura custar o retrato do dia inteiro.
    ultimaConferencia = 0;
    throw erro;
  } finally {
    rodando = false;
  }
}
