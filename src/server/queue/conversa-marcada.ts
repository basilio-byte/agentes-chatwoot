import { Queue } from "bullmq";
import { getRedis } from "./conexao";

export const FILA_CONVERSA_MARCADA = "conversa-marcada";

export type JobConversaMarcada = {
  gatilhoId: string;
  agentId: string;
  /** A entrega gravada em `WebhookEvent`: idempotência e rastro na tela. */
  webhookEventId: string;
  chatwootConversationId: number;
  inboxId: number | null;
  /** A chave do checkbox que foi marcado. */
  atributo: string;
  /** Segundos desde 1970, com fração — o instante da marcação. */
  marcadoEm: number;
  contatoNome: string | null;
  telefone: string | null;
};

/**
 * Espera antes de agir.
 *
 * Curta de propósito: quem marcou está olhando a conversa, e o sistema desmarca
 * "na hora" (decisão do usuário, 15/09/2026). Os segundos são para a automação
 * do Chatwoot que reage ao mesmo checkbox — ela põe a etiqueta — terminar de
 * escrever antes de o worker ler e mesclar os atributos.
 */
const ESPERA_MS = 3_000;

let fila: Queue<JobConversaMarcada> | null = null;

/**
 * Fila do gatilho de checkbox — mesma política da conversa encerrada: três
 * tentativas, e quem decide se ainda é seguro tentar de novo é o worker, pelas
 * tools que já rodaram.
 */
export function getFilaConversaMarcada(): Queue<JobConversaMarcada> {
  fila ??= new Queue<JobConversaMarcada>(FILA_CONVERSA_MARCADA, {
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

/** `jobId` pela entrega: a mesma marcação reentregue vira, no máximo, um job. */
export async function agendarConversaMarcada(dados: JobConversaMarcada) {
  return getFilaConversaMarcada().add("executar", dados, {
    jobId: `marcada-${dados.webhookEventId}`,
    delay: ESPERA_MS,
  });
}
