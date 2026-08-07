import { Queue } from "bullmq";
import { getRedis } from "./conexao";

export const FILA_GATILHO = "gatilho";

export type JobGatilho = {
  agentId: string;
  webhookEventId: string;
  payload: unknown;
  eventType: string;
};

let fila: Queue<JobGatilho> | null = null;

/**
 * Fila do gatilho HTTP — mirror de `atendimento.ts`, mas sem debounce: cada
 * chamada externa é um evento isolado, não há mensagens picotadas do mesmo
 * cliente para agrupar aqui.
 */
export function getFilaGatilho(): Queue<JobGatilho> {
  fila ??= new Queue<JobGatilho>(FILA_GATILHO, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { age: 3_600, count: 500 },
      removeOnFail: { age: 24 * 3_600 },
    },
  });
  return fila;
}

/**
 * `jobId` fixo por entrega (`webhookEventId`) — não por agente: diferente do
 * atendimento do Chatwoot, aqui não existe debounce para agrupar. Cada
 * `WebhookEvent` vira, no máximo, um job.
 */
export async function agendarGatilho(dados: JobGatilho) {
  return getFilaGatilho().add("executar", dados, {
    jobId: `gatilho-${dados.webhookEventId}`,
  });
}
