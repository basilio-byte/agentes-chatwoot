import { z } from "zod";

/**
 * `WebhookEvent.provider` das entregas do gatilho de conversa. É por ele que a
 * tela do agente lista o que chegou e o que foi feito com cada resolução.
 */
export const PROVIDER_DA_ENTREGA = "CONVERSA";

/**
 * O webhook de conta avisando que uma conversa foi resolvida.
 *
 * ⚠ Em `conversation_status_changed` o payload É a conversa: id, caixa, contato
 * e status vêm no topo, sem `conversation` aninhado (conferido em 15/09/2026 na
 * entrega real que o Chatwoot faz ao n8n). Ler só o aninhado faria nenhuma
 * resolução chegar aqui — o mesmo tropeço que `lerConversa` já documenta.
 *
 * Só este evento conta. `conversation_updated` também chega com status
 * "resolved" a cada rótulo ou atributo mexido DEPOIS da resolução — as
 * automações "ao resolver, tire a etiqueta" disparam várias —, e cada uma
 * viraria uma execução paga do mesmo atendimento.
 */
const esquema = z
  .object({
    event: z.string(),
    id: z.union([z.number(), z.string()]).optional(),
    status: z.string().nullish(),
    inbox_id: z.number().nullish(),
    /** Segundos, com fração: o instante em que o status mudou. */
    updated_at: z.union([z.number(), z.string()]).nullish(),
    timestamp: z.union([z.number(), z.string()]).nullish(),
    meta: z
      .object({
        sender: z
          .object({
            name: z.string().nullish(),
            phone_number: z.string().nullish(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export type ConversaResolvida = {
  conversationId: number;
  inboxId: number | null;
  /** Segundos desde 1970 — o instante da resolução, no relógio do Chatwoot. */
  resolvidaEm: number;
  contatoNome: string | null;
  telefone: string | null;
};

function segundos(valor: unknown): number | null {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function lerConversaResolvida(
  payload: unknown,
  agora = Date.now(),
): ConversaResolvida | null {
  const lido = esquema.safeParse(payload);
  if (!lido.success) return null;

  const evento = lido.data;
  if (evento.event !== "conversation_status_changed") return null;
  if ((evento.status ?? "").toLowerCase() !== "resolved") return null;

  const id = Number(evento.id);
  if (!Number.isInteger(id) || id <= 0) return null;

  // `updated_at` é a mudança de status; `timestamp` é a última atividade, que
  // pode ser anterior. Sem nenhum dos dois, vale a chegada.
  const instante =
    segundos(evento.updated_at) ?? segundos(evento.timestamp) ?? agora / 1000;

  return {
    conversationId: id,
    inboxId: evento.inbox_id ?? null,
    resolvidaEm: Math.floor(instante),
    contatoNome: evento.meta?.sender?.name?.trim() || null,
    telefone: evento.meta?.sender?.phone_number?.trim() || null,
  };
}
