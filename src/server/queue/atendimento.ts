import { Queue } from "bullmq";
import { getRedis } from "./conexao";

export const FILA_ATENDIMENTO = "atendimento";

export type JobAtendimento = {
  /** Conversa no Chatwoot — é a unidade de agrupamento do debounce. */
  chatwootConversationId: number;
  agentId: string;
  inboxId: number;
};

/** Um job por conversa — é o que faz o debounce agrupar as mensagens. */
export function idDoJob(chatwootConversationId: number) {
  return `conversa-${chatwootConversationId}`;
}

let fila: Queue<JobAtendimento> | null = null;

export function getFilaAtendimento(): Queue<JobAtendimento> {
  fila ??= new Queue<JobAtendimento>(FILA_ATENDIMENTO, {
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
 * Agenda a resposta de uma conversa, agrupando mensagens picotadas.
 *
 * O truque é o `jobId` fixo por conversa: se o cliente manda três linhas
 * seguidas, as três tentam criar o mesmo job. Removemos o anterior ainda
 * pendente e reagendamos — a contagem recomeça a cada mensagem, e o agente
 * responde uma vez só, já com tudo.
 */
export async function agendarAtendimento(
  dados: JobAtendimento,
  debounceSegundos: number,
) {
  const fila = getFilaAtendimento();
  // Sem `:` — o BullMQ recusa esse caractere em jobId customizado.
  const jobId = idDoJob(dados.chatwootConversationId);

  const existente = await fila.getJob(jobId);
  if (existente) {
    const estado = await existente.getState();
    // Só dá para reagendar o que ainda não começou. Se já está rodando, a
    // mensagem nova entra no próximo ciclo — o worker relê o histórico.
    if (estado === "delayed" || estado === "waiting") {
      await existente.remove();
    }
  }

  return fila.add("responder", dados, {
    jobId,
    delay: Math.max(0, debounceSegundos) * 1000,
  });
}
