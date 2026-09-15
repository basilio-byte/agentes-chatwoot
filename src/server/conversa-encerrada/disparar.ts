import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { EventoDeConversa } from "@/generated/prisma/enums";
import { atendeInbox } from "@/server/agents/equipe";
import { agendarConversaEncerrada } from "@/server/queue/conversa-encerrada";
import { lerConversaResolvida, PROVIDER_DA_ENTREGA } from "./evento";

/**
 * Uma entrega do webhook de conta vira um job por gatilho ligado que atende
 * aquela caixa.
 *
 * Nunca lança: a rota ainda sincroniza a resolução depois disto, e uma falha
 * aqui não pode tirar aquilo do ar.
 *
 * A entrega é gravada ANTES de enfileirar, com a chave no agente, na conversa e
 * no instante da resolução. O Chatwoot reenvia em falha, e cada reenvio viraria
 * uma execução paga do mesmo atendimento; a unique barra o segundo antes.
 */
export async function dispararGatilhosDeConversa(payload: unknown): Promise<number> {
  const resolvida = lerConversaResolvida(payload);
  if (!resolvida) return 0;

  try {
    const gatilhos = await db.gatilhoDeConversa.findMany({
      where: {
        evento: EventoDeConversa.RESOLVIDA,
        enabled: true,
        agent: { active: true, archivedAt: null },
      },
      select: {
        id: true,
        agentId: true,
        agent: { select: { inboxMode: true, inboxIds: true } },
      },
    });

    let agendados = 0;
    for (const gatilho of gatilhos) {
      // O escopo do agente é a lista de caixas — o mesmo da aba Canal.
      if (!atendeInbox(gatilho.agent, resolvida.inboxId)) continue;

      let webhookEventId: string;
      try {
        const entrega = await db.webhookEvent.create({
          data: {
            provider: PROVIDER_DA_ENTREGA,
            externalId: `${gatilho.agentId}:${resolvida.conversationId}:${resolvida.resolvidaEm}`,
            eventType: `conversa #${resolvida.conversationId} resolvida`,
            agentId: gatilho.agentId,
            resultado: "agendado",
            // Sem nome nem telefone: a tabela de entregas é lida pela equipe
            // inteira e podada só depois de 30 dias.
            payload: {
              conversationId: resolvida.conversationId,
              inboxId: resolvida.inboxId,
              resolvidaEm: resolvida.resolvidaEm,
            } as Prisma.InputJsonValue,
          },
        });
        webhookEventId = entrega.id;
      } catch (erro) {
        if (ehConflitoDeUnique(erro)) continue;
        throw erro;
      }

      await agendarConversaEncerrada({
        gatilhoId: gatilho.id,
        agentId: gatilho.agentId,
        webhookEventId,
        chatwootConversationId: resolvida.conversationId,
        inboxId: resolvida.inboxId,
        resolvidaEm: resolvida.resolvidaEm,
        contatoNome: resolvida.contatoNome,
        telefone: resolvida.telefone,
      });
      agendados++;
    }

    return agendados;
  } catch (erro) {
    logger.error(
      { erro, conversa: resolvida.conversationId },
      "não consegui disparar os gatilhos de conversa",
    );
    return 0;
  }
}

function ehConflitoDeUnique(erro: unknown) {
  return (
    typeof erro === "object" &&
    erro !== null &&
    "code" in erro &&
    (erro as { code?: string }).code === "P2002"
  );
}
