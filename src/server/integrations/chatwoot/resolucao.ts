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
      handoffParaAgentId: null,
      handoffResumo: null,
      handoffMotivo: null,
      handoffDeNome: null,
    },
  });
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
  const conversationId = evento.conversation?.id;
  if (!conversationId) return { resolvida: false };

  // O status pode vir na conversa aninhada ou no topo, conforme o evento.
  const status = evento.conversation?.status ?? evento.status;
  if (!ehResolvida(status)) return { resolvida: false };

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
