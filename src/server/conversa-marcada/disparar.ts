import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { EventoDeConversa } from "@/generated/prisma/enums";
import { atendeInbox } from "@/server/agents/equipe";
import { agendarConversaMarcada } from "@/server/queue/conversa-marcada";
import { lerCheckboxesMarcados, PROVIDER_DO_CHECKBOX } from "./evento";

/**
 * Uma entrega do webhook de conta vira um job por gatilho ligado e por checkbox
 * que ele escuta e que acabou de ser marcado.
 *
 * Nunca lança: a rota ainda sincroniza a resolução e o dono depois disto.
 *
 * A entrega é gravada ANTES de enfileirar, com o instante da marcação na chave.
 * O Chatwoot reenvia em falha com o mesmo corpo, e a unique barra o segundo.
 * Desmarcar e marcar de novo é outra mudança, com outro instante: roda de novo.
 */
export async function dispararGatilhosDeCheckbox(payload: unknown): Promise<number> {
  const marcados = lerCheckboxesMarcados(payload);
  if (!marcados) return 0;

  try {
    const gatilhos = await db.gatilhoDeConversa.findMany({
      where: {
        evento: EventoDeConversa.ATRIBUTO_MARCADO,
        enabled: true,
        atributos: { hasSome: marcados.atributos },
        agent: { active: true, archivedAt: null },
      },
      select: {
        id: true,
        agentId: true,
        atributos: true,
        agent: { select: { inboxMode: true, inboxIds: true } },
      },
    });

    let agendados = 0;
    for (const gatilho of gatilhos) {
      // O escopo do agente é a lista de caixas — o mesmo da aba Canal.
      if (!atendeInbox(gatilho.agent, marcados.inboxId)) continue;

      for (const atributo of marcados.atributos) {
        if (!gatilho.atributos.includes(atributo)) continue;

        let webhookEventId: string;
        try {
          const entrega = await db.webhookEvent.create({
            data: {
              provider: PROVIDER_DO_CHECKBOX,
              externalId: `${gatilho.agentId}:${marcados.conversationId}:${atributo}:${Math.round(marcados.marcadoEm * 1000)}`,
              eventType: `conversa #${marcados.conversationId}: ${atributo} marcado`,
              agentId: gatilho.agentId,
              resultado: "agendado",
              // Sem nome nem telefone: a tabela de entregas é lida pela equipe
              // inteira e podada só depois de 30 dias.
              payload: {
                conversationId: marcados.conversationId,
                inboxId: marcados.inboxId,
                atributo,
                marcadoEm: marcados.marcadoEm,
              } as Prisma.InputJsonValue,
            },
          });
          webhookEventId = entrega.id;
        } catch (erro) {
          if (ehConflitoDeUnique(erro)) continue;
          throw erro;
        }

        await agendarConversaMarcada({
          gatilhoId: gatilho.id,
          agentId: gatilho.agentId,
          webhookEventId,
          chatwootConversationId: marcados.conversationId,
          inboxId: marcados.inboxId,
          atributo,
          marcadoEm: marcados.marcadoEm,
          contatoNome: marcados.contatoNome,
          telefone: marcados.telefone,
        });
        agendados++;
      }
    }

    return agendados;
  } catch (erro) {
    logger.error(
      { erro, conversa: marcados.conversationId },
      "não consegui disparar os gatilhos de checkbox",
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
