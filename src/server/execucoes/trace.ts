/**
 * Leitura da transcrição guardada em `AgentRun.messages` — **pura**, para ter
 * teste de mesa.
 *
 * O que está no banco é o array de mensagens do protocolo de chat completions,
 * exatamente como foi mandado à OpenRouter. Ele não foi feito para ser lido por
 * gente: `content` às vezes é string, às vezes é lista de blocos, e a chamada
 * de tool vive num campo à parte. Aqui isso vira linha de texto com um papel.
 */

export type MensagemDoTrace = {
  papel: string;
  conteudo: string;
  /** Nome das tools que o modelo pediu nesta mensagem, se pediu alguma. */
  toolsPedidas: string[];
};

/**
 * Teto por bloco de texto exibido.
 *
 * Um turno com muitas tools devolve JSON de dezenas de milhares de linhas, e
 * jogar tudo isso no DOM trava a aba. Cortar é honesto desde que o corte
 * apareça — quem chama recebe `cortado` e a tela avisa.
 */
export const TETO_DE_TEXTO = 40_000;

export function recortar(valor: unknown): { texto: string; cortado: boolean } {
  if (valor == null) return { texto: "", cortado: false };
  const bruto =
    typeof valor === "string" ? valor : JSON.stringify(valor, null, 2);
  return bruto.length > TETO_DE_TEXTO
    ? { texto: bruto.slice(0, TETO_DE_TEXTO), cortado: true }
    : { texto: bruto, cortado: false };
}

/** O `content` do protocolo é string OU lista de blocos OU nulo. */
export function conteudoLegivel(conteudo: unknown): string {
  if (typeof conteudo === "string") return conteudo;
  if (conteudo == null) return "";
  if (Array.isArray(conteudo)) {
    return conteudo
      .map((bloco) =>
        bloco && typeof bloco === "object" && "text" in bloco
          ? String((bloco as { text: unknown }).text)
          : JSON.stringify(bloco),
      )
      .join("\n");
  }
  return JSON.stringify(conteudo, null, 2);
}

export function lerTranscricao(messages: unknown): {
  mensagens: MensagemDoTrace[];
  cortada: boolean;
} {
  // Execução que morreu antes de gravar deixa `messages` como `[]` ou algo que
  // não é lista. Devolver vazio é melhor que estourar a tela inteira.
  if (!Array.isArray(messages)) return { mensagens: [], cortada: false };

  let cortada = false;

  const mensagens = messages.map((m) => {
    const msg = (m ?? {}) as {
      role?: unknown;
      content?: unknown;
      tool_calls?: unknown;
    };
    const { texto, cortado } = recortar(conteudoLegivel(msg.content));
    if (cortado) cortada = true;

    const pedidos = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    return {
      papel: typeof msg.role === "string" ? msg.role : "?",
      conteudo: texto,
      toolsPedidas: pedidos
        .map((t) => {
          const nome = (t as { function?: { name?: unknown } })?.function?.name;
          return typeof nome === "string" ? nome : null;
        })
        .filter((n): n is string => Boolean(n)),
    };
  });

  return { mensagens, cortada };
}
