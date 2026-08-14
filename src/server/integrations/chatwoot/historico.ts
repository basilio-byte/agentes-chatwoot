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
 * As mensagens que podem virar contexto: fora nota interna, atividade e o que
 * ficou antes do corte do histórico.
 *
 * Separado de `montarContexto` porque a leitura de mídia precisa rodar **entre**
 * os dois passos: ela preenche o `content` de uma mensagem que só tem anexo, e
 * o filtro de conteúdo vazio (lá embaixo) precisa acontecer depois disso. Sem
 * essa separação, um áudio puro era descartado antes de alguém tentar ouvi-lo.
 *
 * Não filtra conteúdo vazio de propósito — esse é o passo seguinte.
 */
export function mensagensCandidatas(
  mensagens: MensagemChatwoot[],
  historicoDesde?: Date | null,
): MensagemChatwoot[] {
  const corteEmSegundos = historicoDesde
    ? Math.floor(historicoDesde.getTime() / 1000)
    : null;

  return mensagens
    .filter((m) => !m.private) // nota interna não é conversa com o cliente
    .filter((m) => m.message_type === 0 || m.message_type === 1) // fora atividade/template
    .filter((m) => {
      if (corteEmSegundos == null) return true;
      // `created_at` do Chatwoot vem em segundos. Sem data, mantém a mensagem:
      // perder contexto é pior que carregar uma linha a mais.
      if (typeof m.created_at !== "number") return true;
      return m.created_at >= corteEmSegundos;
    });
}

/**
 * Transforma as mensagens do Chatwoot no contexto do agente.
 *
 * As mensagens de entrada do fim da lista são o que o cliente acabou de mandar —
 * possivelmente picotado em várias linhas por causa do debounce. Elas viram uma
 * entrada só; o resto vira histórico.
 */
export function montarContexto(
  mensagens: MensagemChatwoot[],
  /**
   * Corte do histórico. Mensagens anteriores são descartadas — é o que faz uma
   * conversa reaberta começar do zero depois de resolvida.
   */
  historicoDesde?: Date | null,
): ContextoConversa | null {
  const uteis = mensagensCandidatas(mensagens, historicoDesde).filter(
    (m) => (m.content ?? "").trim().length > 0,
  );

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
