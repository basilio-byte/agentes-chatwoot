import { z } from "zod";
import { podeAgir } from "./regras";

/**
 * Leitura do payload de webhook do Chatwoot.
 *
 * Propositalmente tolerante: campos opcionais e `passthrough`, porque o formato
 * varia entre versões e canais. Payload inesperado faz o bot ficar quieto e
 * registrar o motivo — nunca derruba a requisição.
 */
export const eventoChatwootSchema = z
  .object({
    event: z.string(),
    id: z.union([z.number(), z.string()]).optional(),
    /**
     * Em `conversation_status_changed` o status vem no topo, e não dentro de
     * `conversation` — depende do evento.
     */
    status: z.string().optional(),
    content: z.string().nullable().optional(),
    message_type: z.string().optional(),
    private: z.boolean().optional(),
    sender: z
      .object({
        id: z.number().optional(),
        type: z.string().optional(),
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
    conversation: z
      .object({
        id: z.number(),
        status: z.string().optional(),
        assignee_id: z.number().nullable().optional(),
        /** O Chatwoot manda a caixa aqui também — ver a resolução mais abaixo. */
        inbox_id: z.number().optional(),
        meta: z
          .object({
            sender: z
              .object({
                name: z.string().optional(),
                identifier: z.string().nullable().optional(),
                email: z.string().nullable().optional(),
                phone_number: z.string().nullable().optional(),
              })
              .passthrough()
              .optional(),
            assignee: z
              .object({ id: z.number().optional() })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    inbox: z.object({ id: z.number(), name: z.string().optional() }).optional(),
  })
  .passthrough();

export type EventoChatwoot = z.infer<typeof eventoChatwootSchema>;

export type Decisao =
  | {
      responder: true;
      conversationId: number;
      inboxId: number;
      texto: string;
      contato: { nome?: string; identificador?: string };
    }
  | { responder: false; motivo: string };

/**
 * Decide se este evento merece uma resposta do agente.
 *
 * As três recusas que mais importam:
 *  - eco do próprio bot (senão ele conversa sozinho para sempre);
 *  - nota privada, que é conversa interna da equipe;
 *  - conversa já assumida por um humano.
 */
export function decidirSeResponde(bruto: unknown): Decisao {
  const parsed = eventoChatwootSchema.safeParse(bruto);
  if (!parsed.success) {
    return { responder: false, motivo: "payload em formato inesperado" };
  }
  const evento = parsed.data;

  if (evento.event !== "message_created") {
    return { responder: false, motivo: `evento ${evento.event} não responde` };
  }

  if (evento.private === true) {
    return { responder: false, motivo: "nota privada" };
  }

  // Só mensagem de entrada. `outgoing` é agente ou o próprio bot — responder a
  // isso cria loop infinito.
  if (evento.message_type !== "incoming") {
    return {
      responder: false,
      motivo: `message_type ${evento.message_type ?? "ausente"}`,
    };
  }

  const tipoRemetente = evento.sender?.type?.toLowerCase();
  if (tipoRemetente && tipoRemetente !== "contact") {
    return { responder: false, motivo: `remetente do tipo ${tipoRemetente}` };
  }

  const conversa = evento.conversation;
  if (!conversa) {
    return { responder: false, motivo: "sem conversa no payload" };
  }

  // Regras globais — mesmas usadas no worker e na checagem ao vivo.
  const veredito = podeAgir({
    status: conversa.status,
    assigneeId: conversa.assignee_id ?? conversa.meta?.assignee?.id ?? null,
  });
  if (!veredito.pode) {
    return { responder: false, motivo: veredito.motivo };
  }

  const texto = (evento.content ?? "").trim();
  if (!texto) {
    return { responder: false, motivo: "mensagem sem texto (anexo?)" };
  }

  // A caixa vem no topo em `message_created`, mas o Chatwoot também a repete
  // dentro de `conversation`. Aceitar as duas evita que uma variação de payload
  // — versão diferente, outro tipo de evento — vire silêncio no atendimento,
  // que é o pior desfecho e o mais difícil de diagnosticar.
  const inboxId = evento.inbox?.id ?? evento.conversation?.inbox_id;
  if (!inboxId) {
    return {
      responder: false,
      motivo:
        "payload sem id da caixa de entrada (nem em inbox.id nem em conversation.inbox_id)",
    };
  }

  return {
    responder: true,
    conversationId: conversa.id,
    inboxId,
    texto,
    contato: {
      nome: conversa.meta?.sender?.name,
      identificador:
        conversa.meta?.sender?.identifier ??
        conversa.meta?.sender?.email ??
        conversa.meta?.sender?.phone_number ??
        undefined,
    },
  };
}
