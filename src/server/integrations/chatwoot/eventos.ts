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
    /**
     * Áudio, imagem, documento, localização.
     *
     * `unknown` de propósito, e não um objeto validado: um item malformado no
     * meio da lista invalidaria o payload INTEIRO, e uma mensagem com texto
     * perfeitamente respondível viraria "formato inesperado". Só o `file_type`
     * é lido aqui; quem entende o resto do shape é
     * `integrations/openai/classificar.ts`.
     */
    attachments: z.array(z.unknown()).nullish(),
  })
  .passthrough();

export type EventoChatwoot = z.infer<typeof eventoChatwootSchema>;

/**
 * `file_type` de cada anexo, ignorando item malformado.
 *
 * Um anexo sem tipo ainda conta como anexo — ele existe, e é isso que decide se
 * a mensagem tem conteúdo. Só que aparece na lista como `"desconhecido"`, para
 * o rastro no painel não mentir dizendo que não havia nada.
 */
function tiposDosAnexos(brutos: unknown): string[] {
  if (!Array.isArray(brutos)) return [];

  return brutos
    .filter((a) => typeof a === "object" && a !== null)
    .map((a) => {
      const tipo = (a as { file_type?: unknown }).file_type;
      return typeof tipo === "string" && tipo.trim()
        ? tipo.toLowerCase().trim()
        : "desconhecido";
    });
}

export type Decisao =
  | {
      responder: true;
      conversationId: number;
      inboxId: number;
      texto: string;
      /**
       * `file_type` de cada anexo, como veio do Chatwoot. Vazio na esmagadora
       * maioria das mensagens.
       */
      anexos: string[];
      /**
       * A mensagem é SÓ anexo — sem uma palavra digitada. É o áudio de
       * WhatsApp, o caso mais comum de todos.
       *
       * A rota usa isto para decidir se agenda: sem leitura de mídia ligada,
       * este atendimento continua sendo recusado exatamente como antes.
       */
      soAnexo: boolean;
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

  // "Resolvida" NÃO cala uma mensagem nova do cliente: ela é justamente o sinal
  // de que a conversa voltou a existir. O Chatwoot costuma reabrir sozinho, mas
  // nem sempre reabre (visto em produção, 2026-08-03) — e quando ele não
  // reabre, recusar aqui deixava a conversa muda para sempre, porque nada mais
  // chegaria a mudar aquele status. Quem reabre no Chatwoot é o worker.
  //
  // As outras recusas continuam valendo, inclusive dono humano.
  if (!veredito.pode && !veredito.resolvida) {
    return { responder: false, motivo: veredito.motivo };
  }

  const texto = (evento.content ?? "").trim();
  const anexos = tiposDosAnexos(evento.attachments);

  // Mensagem sem texto E sem anexo não existe para o atendimento. Com anexo,
  // existe: é o áudio de WhatsApp, e recusá-lo aqui era o que fazia o bot ficar
  // mudo para quem prefere falar a digitar.
  if (!texto && anexos.length === 0) {
    return { responder: false, motivo: "mensagem sem texto nem anexo" };
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
    anexos,
    soAnexo: !texto && anexos.length > 0,
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
