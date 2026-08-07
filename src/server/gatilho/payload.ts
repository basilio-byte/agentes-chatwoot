/**
 * Constrói a `mensagem` que `executarAgente` recebe quando o turno vem de um
 * gatilho HTTP externo, não de uma conversa do Chatwoot.
 *
 * Dump de JSON cru com um preâmbulo curto — não achata o payload em texto
 * livre. Modelos atuais leem JSON estruturado sem perda; achatar perderia a
 * árvore (arrays, aninhamento como `history_items` do ClickUp) e ainda
 * precisaria de uma lógica genérica de achatamento que quebra para formatos
 * imprevisíveis, já que o payload é arbitrário por definição.
 */
export function montarMensagemDoGatilho(args: {
  eventType: string;
  payload: unknown;
}): string {
  return [
    `[Gatilho HTTP externo — evento "${args.eventType}", fora de uma conversa do Chatwoot. Aja conforme suas instruções para este tipo de evento; não há cliente esperando resposta em texto.]`,
    "",
    "Payload recebido (JSON):",
    "```json",
    JSON.stringify(args.payload, null, 2),
    "```",
  ].join("\n");
}

/**
 * Nome do evento, tentando os campos mais comuns entre sistemas diferentes.
 *
 * O ClickUp usa `event` (`"taskCreated"`); outros sistemas usam `event_type`
 * ou `type`. Sem nenhum desses, "desconhecido" — nunca falha por isso.
 */
export function extrairEventType(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "desconhecido";
  const p = payload as Record<string, unknown>;
  const valor = p.event ?? p.event_type ?? p.type;
  return typeof valor === "string" && valor.trim() ? valor : "desconhecido";
}

/**
 * Chave do recurso que o payload afeta, para a trava anti-loop (`anti-loop.ts`)
 * agrupar chamadas que dizem respeito à MESMA coisa (ex.: a mesma tarefa do
 * ClickUp), mesmo quando o `eventType` muda entre elas.
 *
 * Genérica de propósito — não hardcoded para o ClickUp — tenta os nomes de
 * campo mais comuns, nesta ordem, no nível raiz do payload.
 */
const CAMPOS_DE_RECURSO = ["task_id", "resource_id", "object_id", "id"] as const;

export function extrairRecursoChave(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  for (const campo of CAMPOS_DE_RECURSO) {
    const valor = p[campo];
    if (typeof valor === "string" && valor.trim()) return valor;
    if (typeof valor === "number") return String(valor);
  }
  return undefined;
}
