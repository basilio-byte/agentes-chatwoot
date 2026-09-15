import { Queue } from "bullmq";
import { getRedis } from "./conexao";

export const FILA_CONVERSA_ENCERRADA = "conversa-encerrada";

export type JobConversaEncerrada = {
  gatilhoId: string;
  agentId: string;
  /** A entrega gravada em `WebhookEvent`: idempotência e rastro na tela. */
  webhookEventId: string;
  chatwootConversationId: number;
  inboxId: number | null;
  /** Segundos desde 1970 — o instante da resolução. */
  resolvidaEm: number;
  contatoNome: string | null;
  telefone: string | null;
};

/**
 * Espera antes de ler a conversa.
 *
 * O Chatwoot grava a atividade "marcada como resolvida" depois de avisar, e as
 * automações de "ao resolver" (desatribuir, tirar etiqueta) chegam logo em
 * seguida. Ler no mesmo instante do aviso podia não achar a atividade que marca
 * o fim do atendimento.
 */
const ESPERA_MS = 30_000;

let fila: Queue<JobConversaEncerrada> | null = null;

/**
 * Fila do gatilho de conversa — mesma política do gatilho HTTP: três tentativas,
 * e quem decide se ainda é seguro tentar de novo é o worker, pelas tools que já
 * rodaram.
 */
export function getFilaConversaEncerrada(): Queue<JobConversaEncerrada> {
  fila ??= new Queue<JobConversaEncerrada>(FILA_CONVERSA_ENCERRADA, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 3_600, count: 500 },
      removeOnFail: { age: 24 * 3_600 },
    },
  });
  return fila;
}

/** `jobId` pela entrega: a mesma resolução reentregue vira, no máximo, um job. */
export async function agendarConversaEncerrada(dados: JobConversaEncerrada) {
  return getFilaConversaEncerrada().add("executar", dados, {
    jobId: `encerrada-${dados.webhookEventId}`,
    delay: ESPERA_MS,
  });
}
