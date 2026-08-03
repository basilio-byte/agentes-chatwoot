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

    // `active` é o único estado em que não dá para mexer: o job está rodando
    // agora, e o `add` abaixo seria IGNORADO em silêncio. Deixamos um recado
    // no Redis — o worker o lê quando o turno termina e agenda o próximo.
    //
    // Sem esse recado a mensagem sumia de vez: o agente responde ao turno
    // anterior, zera `aguardandoDesde` ao responder, e o vigia deixa de vigiar
    // justamente a mensagem que ninguém leu. Silêncio sem erro nenhum.
    if (estado === "active") {
      await marcarPendente(dados.chatwootConversationId);
      return null;
    }

    // Todo o resto sai, inclusive `failed` e `completed`. O BullMQ IGNORA em
    // silêncio um `add` com jobId que já existe, mesmo terminado: um job que
    // falhou de vez envenenava a conversa pelas 24h do `removeOnFail`, e toda
    // mensagem seguinte sumia sem processar e sem deixar rastro. Foi assim que
    // uma conversa ficou muda depois de um 401 (produção, 2026-07-31).
    await existente.remove();
  }

  return fila.add("responder", dados, {
    jobId,
    delay: Math.max(0, debounceSegundos) * 1000,
  });
}

/**
 * Recado de "chegou mensagem enquanto o turno rodava".
 *
 * Fica no Redis, e não no Postgres, porque é estado de fila e some sozinho: se
 * o worker morrer antes de consumir, a próxima mensagem do cliente reagenda de
 * qualquer forma, e o TTL evita recado eterno de conversa abandonada.
 */
const CHAVE_PENDENTE = (chatwootConversationId: number) =>
  `atendimento:pendente:${chatwootConversationId}`;

const VALIDADE_DO_RECADO_S = 3600;

async function marcarPendente(chatwootConversationId: number) {
  await getRedis().set(
    CHAVE_PENDENTE(chatwootConversationId),
    "1",
    "EX",
    VALIDADE_DO_RECADO_S,
  );
}

/**
 * Lê **e apaga** o recado numa operação só.
 *
 * Atômico de propósito: o worker roda com concorrência 4, e dois turnos
 * terminando juntos não podem reagendar a mesma mensagem duas vezes.
 */
export async function consumirPendente(
  chatwootConversationId: number,
): Promise<boolean> {
  const chave = CHAVE_PENDENTE(chatwootConversationId);
  const resultado = await getRedis().multi().get(chave).del(chave).exec();
  return resultado?.[0]?.[1] === "1";
}
