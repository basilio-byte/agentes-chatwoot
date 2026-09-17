import { db } from "@/lib/db";

/**
 * O robô da caixa: a porta por onde a conversa entrou e, se ela nunca passou
 * por um agente nosso, a porta mais recente da mesma caixa — o Chatwoot amarra
 * um bot por caixa de entrada.
 *
 * Extraído de `nps/executar.ts` em 17/09/2026, quando a varredura de conversas
 * paradas precisou da mesma resposta. Copiar seria a capacidade duplicada que
 * este projeto já viu divergir três vezes; e o caso que obriga a existir é o
 * mesmo nos dois: a conversa pode ser mais antiga que o nosso sistema, ou nunca
 * ter tido uma mensagem que passasse pelo webhook do bot, e aí não há
 * `Conversation.portaAgentId` para ler.
 */
export async function portaDaCaixa(
  conversa: number,
  inboxId: number | null,
): Promise<string | null> {
  const local = await db.conversation.findUnique({
    where: { chatwootConversationId: conversa },
    select: { portaAgentId: true },
  });
  if (local?.portaAgentId) return local.portaAgentId;
  if (inboxId == null) return null;

  const vizinha = await db.conversation.findFirst({
    where: { chatwootInboxId: inboxId, portaAgentId: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { portaAgentId: true },
  });
  return vizinha?.portaAgentId ?? null;
}
