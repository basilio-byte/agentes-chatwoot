import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ConversationStatus } from "@/generated/prisma/enums";
import { eventoChatwootSchema } from "./eventos";
import { ehResolvida } from "./regras";

/**
 * Marca a conversa como encerrada e corta o histórico.
 *
 * O corte é o coração da regra: o mesmo cliente costuma voltar por outro
 * assunto, e arrastar o contexto anterior faria o agente responder a pergunta
 * errada. Reabriu, começa do zero.
 *
 * Zera junto o dono e o bastão. Sem isso, uma conversa reaberta voltaria direto
 * para o especialista do atendimento passado — que é justamente o contexto que
 * a regra manda esquecer.
 *
 * Mora fora do worker de propósito: as rotas de webhook precisam dela, e
 * importar o worker traria o BullMQ inteiro para dentro do processo web.
 */
export async function marcarResolvida(chatwootConversationId: number) {
  const agora = new Date();
  await db.conversation.updateMany({
    where: { chatwootConversationId },
    data: {
      status: ConversationStatus.CLOSED,
      resolvidaEm: agora,
      historicoDesde: agora,
      agentId: null,
      // Ninguém mais está esperando. Sem zerar, o relógio antigo sobreviveria
      // à reabertura e o vigia escalaria a conversa nova no primeiro minuto.
      aguardandoDesde: null,
      handoffParaAgentId: null,
      handoffResumo: null,
      handoffMotivo: null,
      handoffDeNome: null,
    },
  });
}

/**
 * De onde sai o id e o status da conversa — que **muda conforme o evento**.
 *
 * Em `message_created` o payload é a mensagem, e a conversa vem aninhada em
 * `conversation`. Em `conversation_status_changed` e `conversation_updated` o
 * payload **é a própria conversa**: o id está no topo, em `id`, e não existe
 * `conversation` nenhum.
 *
 * Olhar só o lugar aninhado fazia a resolução passar batido — o evento chegava,
 * era registrado, e saía sem fazer nada (constatado em produção, 2026-07-31).
 * Aceitar as duas formas é o que torna isto confiável.
 */
export function lerConversa(evento: {
  event: string;
  id?: number | string;
  status?: string;
  conversation?: { id?: number; status?: string };
}): { conversationId?: number; status?: string } {
  if (evento.conversation?.id) {
    return {
      conversationId: evento.conversation.id,
      status: evento.conversation.status ?? evento.status,
    };
  }

  // Sem conversa aninhada: só faz sentido tratar o topo como conversa quando o
  // evento é de conversa. Em `message_created`, o `id` do topo é da MENSAGEM —
  // usá-lo apontaria para a conversa errada.
  if (!evento.event.startsWith("conversation_")) return {};

  const id = Number(evento.id);
  return {
    conversationId: Number.isInteger(id) && id > 0 ? id : undefined,
    status: evento.status ?? evento.conversation?.status,
  };
}

/**
 * Detecta, em qualquer entrega de webhook, que a conversa foi resolvida.
 *
 * Vale para o webhook **de bot** também, e não só para o de conta: na prática o
 * Agent Bot recebe `conversation_updated` (visto em produção, 2026-07-31), e
 * nós descartávamos esse evento. O resultado era uma conversa resolvida no
 * Chatwoot que continuava atribuída ao agente aqui, com o histórico intacto —
 * até alguém escrever nela de novo.
 *
 * Devolve `true` quando de fato marcou, para quem chama registrar o desfecho.
 */
export async function sincronizarResolucao(
  payload: unknown,
): Promise<{ resolvida: boolean; conversationId?: number }> {
  const parsed = eventoChatwootSchema.safeParse(payload);
  if (!parsed.success) return { resolvida: false };

  const evento = parsed.data;
  const { conversationId, status } = lerConversa(evento);

  if (!conversationId || !ehResolvida(status)) return { resolvida: false };

  // Conversa que nunca passou por um agente nosso não tem o que sincronizar.
  const conhecida = await db.conversation.findUnique({
    where: { chatwootConversationId: conversationId },
    select: { id: true, status: true },
  });
  if (!conhecida) return { resolvida: false };
  if (conhecida.status === ConversationStatus.CLOSED) {
    return { resolvida: false, conversationId };
  }

  await marcarResolvida(conversationId);
  logger.info(
    { conversa: conversationId },
    "conversa resolvida — dono liberado e histórico cortado",
  );

  return { resolvida: true, conversationId };
}
