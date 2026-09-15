import { z } from "zod";

/**
 * `WebhookEvent.provider` das entregas do gatilho de checkbox. Separado do da
 * conversa encerrada para cada cartão da aba Gatilhos listar só o que é dele.
 */
export const PROVIDER_DO_CHECKBOX = "CHECKBOX";

/**
 * Chave de atributo de conversa como o Chatwoot gera: minúsculas, dígitos e
 * sublinhado (`passar_para_crm`, `nps_espaos`). É o que a tela aceita.
 */
export const CHAVE_DE_CHECKBOX = /^[a-z0-9_]{1,60}$/;

/** Mais que isto num agente só é configuração errada, não caso de uso. */
export const LIMITE_DE_CHECKBOXES = 10;

/**
 * As chaves como a tela manda: uma por linha, ou separadas por vírgula ou ponto
 * e vírgula. Chave fora do formato volta em `invalidas`, para a tela recusar em
 * voz alta — um erro de digitação aceito seria um checkbox que nunca dispara.
 */
export function lerChavesDeCheckbox(texto: string): {
  chaves: string[];
  invalidas: string[];
} {
  const chaves: string[] = [];
  const invalidas: string[] = [];

  for (const bruta of texto.split(/[\n,;]+/)) {
    const chave = bruta.trim();
    if (!chave) continue;
    if (!CHAVE_DE_CHECKBOX.test(chave)) {
      invalidas.push(chave.slice(0, 60));
      continue;
    }
    if (!chaves.includes(chave)) chaves.push(chave);
  }

  return { chaves: chaves.slice(0, LIMITE_DE_CHECKBOXES), invalidas };
}

/**
 * O webhook de conta avisando que um checkbox da conversa foi MARCADO.
 *
 * Vem em `conversation_updated`, com a conversa no topo e a mudança em
 * `changed_attributes`. Conferido em 15/09/2026 na entrega real do Chatwoot
 * quando alguém marcou o `passar_para_crm`:
 *
 *   changed_attributes: [
 *     { updated_at: { previous_value: …, current_value: … } },
 *     { custom_attributes: { previous_value: { …, passar_para_crm: null },
 *                            current_value:  { …, passar_para_crm: true } } },
 *   ]
 *
 * ⚠ Dispara na VIRADA para marcado, nunca pelo estado. `conversation_updated`
 * chega a cada rótulo, dono ou mensagem, e a conversa carrega os atributos
 * inteiros em todas: ler só `custom_attributes` faria o mesmo checkbox marcado
 * acionar o agente a cada mudança da conversa, até alguém desmarcar. Sem
 * `changed_attributes`, não dispara.
 *
 * A virada de volta — o sistema desmarcando — também chega aqui, e cai fora pela
 * mesma regra.
 */
const esquema = z
  .object({
    event: z.string(),
    id: z.union([z.number(), z.string()]).optional(),
    inbox_id: z.number().nullish(),
    /** Segundos, com fração: o instante desta mudança. */
    updated_at: z.union([z.number(), z.string()]).nullish(),
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
    changed_attributes: z.array(z.unknown()).nullish(),
  })
  .passthrough();

export type CheckboxesMarcados = {
  conversationId: number;
  inboxId: number | null;
  /** Segundos desde 1970, com fração — o instante em que foi marcado. */
  marcadoEm: number;
  /** As chaves que viraram marcadas nesta entrega, em ordem alfabética. */
  atributos: string[];
  contatoNome: string | null;
  telefone: string | null;
};

function objeto(valor: unknown): Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

/** O Chatwoot grava checkbox como booleano; o texto fica por segurança. */
function marcado(valor: unknown): boolean {
  return valor === true || valor === "true";
}

function segundos(valor: unknown): number | null {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function lerCheckboxesMarcados(
  payload: unknown,
  agora = Date.now(),
): CheckboxesMarcados | null {
  const lido = esquema.safeParse(payload);
  if (!lido.success) return null;

  const evento = lido.data;
  if (evento.event !== "conversation_updated") return null;

  const id = Number(evento.id);
  if (!Number.isInteger(id) || id <= 0) return null;

  const mudanca = (evento.changed_attributes ?? [])
    .map(objeto)
    .find((item) => "custom_attributes" in item);
  if (!mudanca) return null;

  const { previous_value, current_value } = objeto(mudanca.custom_attributes);
  const antes = objeto(previous_value);
  const depois = objeto(current_value);

  const atributos = Object.keys(depois)
    .filter((chave) => marcado(depois[chave]) && !marcado(antes[chave]))
    .sort();
  if (atributos.length === 0) return null;

  return {
    conversationId: id,
    inboxId: evento.inbox_id ?? null,
    marcadoEm: segundos(evento.updated_at) ?? agora / 1000,
    atributos,
    contatoNome: evento.meta?.sender?.name?.trim() || null,
    telefone: evento.meta?.sender?.phone_number?.trim() || null,
  };
}
