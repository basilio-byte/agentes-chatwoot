import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { RunStatus } from "@/generated/prisma/enums";
import { pedirParada } from "@/server/agents/cancelamento";
import { encerrarOcorrenciasInterrompidas } from "@/server/queue/agendamento-worker";
import { IDADE_DE_ZUMBI_MS } from "./limites";

/**
 * Encerramento automático das execuções órfãs.
 *
 * Até 21/09/2026 a única saída de uma execução presa em `RUNNING` era alguém
 * abrir Execuções e clicar em "parar" — e ninguém abre a tela para procurar o
 * que não aparece como erro. No dia em que isto foi escrito havia QUATRO
 * rodando: a de um deploy daquela manhã e três de agosto, paradas havia
 * semanas no topo do filtro "Rodando".
 *
 * Roda no vigia, a cada `CONFERIR_ORFAS_A_CADA_MS`, e usa a mesma régua do
 * botão (`IDADE_DE_ZUMBI_MS`).
 *
 * - **Entra como ERRO, não como parada.** `CANCELED` é "alguém decidiu parar",
 *   e fica fora da contagem de erros de Consumo — que é exatamente o jeito de a
 *   execução perdida continuar despercebida. Aqui ninguém decidiu nada, e o
 *   trabalho não foi feito.
 * - **Deixa também o recado de parada.** Idade não prova que o processo morreu:
 *   um turno vivo e pendurado numa chamada ao modelo também passa daqui, e o
 *   recado o interrompe na verificação seguinte (ele então se grava como
 *   parado, por cima deste erro — é o desfecho verdadeiro dele). Numa órfã de
 *   verdade, o recado expira sozinho em uma hora.
 * - ⚠ **O recado tem prazo.** A conexão do Redis tem `maxRetriesPerRequest:
 *   null` (exigência do BullMQ): com ele fora do ar, um comando espera para
 *   sempre, e penduraria o vigia inteiro — escalada e prazos junto.
 */

export const CONFERIR_ORFAS_A_CADA_MS = 10 * 60_000;

/** Entra na nota interna e no erro do turno vivo, depois de "interrompida no painel por". */
export const QUEM_ENCERRA = `encerramento automático (o turno passou de ${IDADE_DE_ZUMBI_MS / 60_000} minutos)`;

const PRAZO_DO_RECADO_MS = 1_500;

export function erroDaOrfa(minutos: number): string {
  return (
    `Encerrada automaticamente: ficou ${minutos} minutos marcada como rodando e ` +
    "nenhum processo a terminou — o mais provável é o painel ter reiniciado no " +
    "meio do turno (deploy). O que as ferramentas já tinham feito continua " +
    "feito; o resto não foi feito."
  );
}

let ultimaConferencia = 0;
let conferindo = false;

export type RodadaDeOrfas = {
  acao: "cedo" | "em andamento" | "conferido";
  execucoes?: number;
  agendamentos?: number;
};

/** Chamada pelo vigia a cada minuto; confere de fato a cada `CONFERIR_ORFAS_A_CADA_MS`. */
export async function encerrarOrfas(agora = new Date()): Promise<RodadaDeOrfas> {
  if (conferindo) return { acao: "em andamento" };
  if (agora.getTime() - ultimaConferencia < CONFERIR_ORFAS_A_CADA_MS) {
    return { acao: "cedo" };
  }

  conferindo = true;
  ultimaConferencia = agora.getTime();
  try {
    const corte = new Date(agora.getTime() - IDADE_DE_ZUMBI_MS);
    const execucoes = await encerrarExecucoesOrfas(corte, agora);
    const agendamentos = await encerrarOcorrenciasInterrompidas(corte, agora);
    return { acao: "conferido", execucoes, agendamentos };
  } finally {
    conferindo = false;
  }
}

async function encerrarExecucoesOrfas(corte: Date, agora: Date): Promise<number> {
  // Sem índice por status: a consulta anda pelo de `createdAt`. Por isso roda de
  // dez em dez minutos, e não a cada minuto como o resto do vigia.
  const orfas = await db.agentRun.findMany({
    where: { status: RunStatus.RUNNING, createdAt: { lt: corte } },
    select: { id: true, createdAt: true },
    take: 100,
  });

  let encerradas = 0;
  for (const run of orfas) {
    await recadoComPrazo(run.id);

    const minutos = Math.floor((agora.getTime() - run.createdAt.getTime()) / 60_000);
    const { count } = await db.agentRun.updateMany({
      // O `status` no where: um turno que terminou entre a leitura e esta
      // escrita tem o desfecho dele, não o nosso.
      where: { id: run.id, status: RunStatus.RUNNING },
      data: { status: RunStatus.ERROR, error: erroDaOrfa(minutos), finishedAt: agora },
    });
    if (count > 0) {
      encerradas++;
      logger.warn({ runId: run.id, minutos }, "execução órfã encerrada automaticamente");
    }
  }
  return encerradas;
}

async function recadoComPrazo(runId: string): Promise<void> {
  let prazo: ReturnType<typeof setTimeout> | undefined;
  const estourou = new Promise<void>((resolve) => {
    prazo = setTimeout(resolve, PRAZO_DO_RECADO_MS);
  });
  try {
    await Promise.race([pedirParada(runId, QUEM_ENCERRA), estourou]);
  } finally {
    clearTimeout(prazo);
  }
}

/** Só para teste: o ritmo da conferência vive na memória do processo. */
export function esquecerUltimaConferenciaDeOrfas() {
  ultimaConferencia = 0;
  conferindo = false;
}
