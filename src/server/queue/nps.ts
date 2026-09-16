import { Queue } from "bullmq";
import { getRedis } from "./conexao";

export const FILA_NPS = "nps";

export type JobNps = { pesquisaId: string };

let fila: Queue<JobNps> | null = null;

/**
 * Fila da pesquisa de satisfação. Só adianta o relógio: o estado mora na
 * `PesquisaNps`, e o vigia executa de minuto em minuto o que estiver vencido —
 * job perdido, Redis limpo ou worker reiniciado atrasam um minuto, não somem.
 *
 * Uma tentativa e sem `jobId`: cada etapa se trava trocando o status no banco,
 * então job repetido não age duas vezes, e quem tenta de novo é o vigia.
 */
export function getFilaNps(): Queue<JobNps> {
  fila ??= new Queue<JobNps>(FILA_NPS, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 3_600, count: 500 },
      removeOnFail: { age: 24 * 3_600 },
    },
  });
  return fila;
}

export async function agendarPesquisaNps(pesquisaId: string, esperaMs = 0) {
  return getFilaNps().add(
    "avancar",
    { pesquisaId },
    { delay: Math.max(0, Math.round(esperaMs)) },
  );
}
