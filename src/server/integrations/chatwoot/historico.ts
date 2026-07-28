import type { MensagemChatwoot } from "./client";
import type { MensagemHistorico } from "@/server/agents/runner";

/** Quantos turnos passados mandar ao modelo. Mais que isso custa sem ajudar. */
export const LIMITE_HISTORICO = 30;

export type ContextoConversa = {
  historico: MensagemHistorico[];
  /** As mensagens novas do cliente, já agrupadas numa entrada só. */
  mensagem: string;
};

/**
 * Transforma as mensagens do Chatwoot no contexto do agente.
 *
 * As mensagens de entrada do fim da lista são o que o cliente acabou de mandar —
 * possivelmente picotado em várias linhas por causa do debounce. Elas viram uma
 * entrada só; o resto vira histórico.
 */
export function montarContexto(
  mensagens: MensagemChatwoot[],
): ContextoConversa | null {
  const uteis = mensagens
    .filter((m) => !m.private) // nota interna não é conversa com o cliente
    .filter((m) => m.message_type === 0 || m.message_type === 1) // fora atividade/template
    .filter((m) => (m.content ?? "").trim().length > 0);

  if (uteis.length === 0) return null;

  // Do fim para trás, tudo que é entrada faz parte da mensagem nova.
  const novas: string[] = [];
  let corte = uteis.length;
  for (let i = uteis.length - 1; i >= 0; i--) {
    if (uteis[i].message_type !== 0) break;
    novas.unshift((uteis[i].content ?? "").trim());
    corte = i;
  }

  // Última mensagem é do bot: nada novo para responder.
  if (novas.length === 0) return null;

  const historico = uteis
    .slice(0, corte)
    .slice(-LIMITE_HISTORICO)
    .map((m) => ({
      role: m.message_type === 0 ? ("user" as const) : ("assistant" as const),
      content: (m.content ?? "").trim(),
    }));

  return { historico, mensagem: novas.join("\n") };
}
