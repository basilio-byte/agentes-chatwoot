import { Queue } from "bullmq";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { FUSO_SEAHUB } from "@/lib/tempo";
import { reconciliar } from "@/server/agenda/reconciliacao";
import { getRedis } from "./conexao";

export const FILA_AGENDAMENTO = "agendamento";

export type JobAgendamento = {
  scheduleId: string;
  agentId: string;
};

let fila: Queue<JobAgendamento> | null = null;

export function getFilaAgendamento(): Queue<JobAgendamento> {
  fila ??= new Queue<JobAgendamento>(FILA_AGENDAMENTO, {
    connection: getRedis(),
    defaultJobOptions: {
      // Menos tentativas que as outras filas: o retry aqui é para instabilidade
      // de rede antes de qualquer tool. Um agendamento que falha de verdade
      // espera a próxima ocorrência, que já vem sozinha — não há cliente no
      // aguardo justificando insistir.
      attempts: 2,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 7 * 24 * 3_600, count: 200 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    },
  });
  return fila;
}

/** `jobId` do BullMQ não aceita `:` — mesma regra do atendimento. */
export function idDoAgendador(scheduleId: string) {
  return `agendamento-${scheduleId}`;
}

/**
 * Insere ou atualiza o agendador no Redis.
 *
 * ⚠ `tz` é obrigatório e não tem padrão seguro. O container roda em UTC: sem
 * ele, "todo dia às 9h" dispara às 6h da manhã em São Paulo — três horas
 * errado, todo dia, sem erro nenhum.
 */
export async function sincronizarAgendador(schedule: {
  id: string;
  agentId: string;
  nome: string;
  cron: string;
}) {
  await getFilaAgendamento().upsertJobScheduler(
    idDoAgendador(schedule.id),
    { pattern: schedule.cron, tz: FUSO_SEAHUB },
    {
      name: "executar",
      data: { scheduleId: schedule.id, agentId: schedule.agentId },
    },
  );
}

export async function removerAgendador(scheduleId: string) {
  await getFilaAgendamento().removeJobScheduler(idDoAgendador(scheduleId));
}

/** Quando é a próxima execução de cada agendador, direto do Redis. */
export async function proximasExecucoes(): Promise<Map<string, Date>> {
  const mapa = new Map<string, Date>();
  try {
    const agendadores = await getFilaAgendamento().getJobSchedulers(0, 200);
    for (const a of agendadores) {
      if (a.next) mapa.set(a.key, new Date(a.next));
    }
  } catch (erro) {
    // A tela cai para o cálculo pelo cron, que é equivalente. Melhor esforço.
    logger.warn({ erro }, "não consegui ler os agendadores do Redis");
  }
  return mapa;
}

/**
 * Faz o Redis refletir o Postgres.
 *
 * Roda toda vez que o worker sobe, e é o que impede um Redis limpo de apagar os
 * agendamentos em silêncio: o BullMQ guarda o relógio, mas quem sabe o que
 * deveria existir é o banco.
 *
 * Também conserta o caso inverso — agendamento apagado ou desligado enquanto o
 * worker estava fora, cujo agendador continuaria disparando sozinho.
 */
export async function reconciliarAgendadores(): Promise<{
  sincronizados: number;
  removidos: number;
}> {
  const ligados = await db.agentSchedule.findMany({
    where: {
      enabled: true,
      agent: { active: true, archivedAt: null },
    },
    select: { id: true, agentId: true, nome: true, cron: true },
  });

  const fila = getFilaAgendamento();
  const existentes = (await fila.getJobSchedulers(0, 500)).map((a) => a.key);

  const plano = reconciliar(
    ligados.map((s) => idDoAgendador(s.id)),
    existentes.filter((k) => k.startsWith("agendamento-")),
  );

  for (const schedule of ligados) {
    try {
      await sincronizarAgendador(schedule);
    } catch (erro) {
      // Um agendamento com expressão inválida não pode impedir os outros de
      // subir. Ele fica sem disparar, e o rastro sai no log e na tela.
      logger.error(
        { scheduleId: schedule.id, cron: schedule.cron, erro },
        "não consegui sincronizar o agendamento",
      );
    }
  }

  for (const chave of plano.paraRemover) {
    try {
      await fila.removeJobScheduler(chave);
    } catch (erro) {
      logger.warn({ chave, erro }, "não consegui remover agendador órfão");
    }
  }

  logger.info(
    { sincronizados: ligados.length, removidos: plano.paraRemover.length },
    "agendadores reconciliados",
  );

  return { sincronizados: ligados.length, removidos: plano.paraRemover.length };
}
