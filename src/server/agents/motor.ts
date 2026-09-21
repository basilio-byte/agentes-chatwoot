import { ehInterrupcao } from "./cancelamento";

/**
 * O motor de um turno: OpenRouter (o de sempre) ou o proxy Claude MAX.
 *
 * Pedido do usuário em 21/09/2026, com duas condições: *"não quebrar nosso
 * sistema atual"* e *"tem que ser algo fácil de dar switch openrouter <> proxy"*.
 * Daí a forma:
 *
 * - **Uma chave geral** (`MotorDosAgentes`), que nasce desligada. Desligada, todo
 *   agente em `PADRAO` roda na OpenRouter exatamente como antes.
 * - **Por agente**, dá para fixar um motor ("sempre OpenRouter", "sempre Claude
 *   MAX") — é como se testa num agente só antes de virar a chave de todos.
 * - **O proxy falhou, a MESMA chamada vai para a OpenRouter**, com o modelo que
 *   o agente já tem lá, e o resto do turno segue nela. O cliente não percebe;
 *   a execução registra a volta e o motivo.
 *
 * O proxy (`claude-max-api-proxy`, projeto à parte do usuário) fala o mesmo
 * protocolo de chat completions, com ferramentas: por isso o laço do runner é
 * um só, e só muda para quem a chamada vai.
 */

export type Motor = "OPENROUTER" | "CLAUDE_MAX";
export type MotorDoAgente = "PADRAO" | Motor;

/** Prefixo em `AgentRun.model`: separa na apuração o que não é cobrado por token. */
export const PREFIXO_CLAUDE_MAX = "claude-max/";

export const MODELO_PADRAO_CLAUDE_MAX = "claude-sonnet-5";

export type ResolucaoDoMotor = {
  motor: Motor;
  /** O modelo no proxy. Nulo quando o motor é a OpenRouter. */
  modeloClaude: string | null;
  /** A frase que a tela mostra: por que este agente está neste motor. */
  porque: string;
};

/**
 * Qual motor vale para o agente agora.
 *
 * ⚠ Proxy sem URL ou chave configurada nunca é escolhido, nem com o agente
 * fixado nele: a OpenRouter é o chão. Escolher o proxy e falhar em toda chamada
 * daria no mesmo lugar, só que mais devagar.
 */
export function resolverMotor(args: {
  motorDoAgente: MotorDoAgente;
  modeloDoAgente: string | null;
  chaveGeralLigada: boolean;
  modeloPadrao: string;
  proxyConfigurado: boolean;
}): ResolucaoDoMotor {
  const modeloClaude = args.modeloDoAgente?.trim() || args.modeloPadrao;
  const openrouter = (porque: string): ResolucaoDoMotor => ({
    motor: "OPENROUTER",
    modeloClaude: null,
    porque,
  });

  if (args.motorDoAgente === "OPENROUTER") return openrouter("fixado na OpenRouter");

  if (!args.proxyConfigurado) {
    return openrouter(
      args.motorDoAgente === "CLAUDE_MAX"
        ? "fixado no Claude MAX, mas o proxy não está configurado — ficou na OpenRouter"
        : "segue a chave geral; o proxy não está configurado",
    );
  }

  if (args.motorDoAgente === "CLAUDE_MAX") {
    return { motor: "CLAUDE_MAX", modeloClaude, porque: "fixado no Claude MAX" };
  }

  return args.chaveGeralLigada
    ? { motor: "CLAUDE_MAX", modeloClaude, porque: "segue a chave geral, que está no Claude MAX" }
    : openrouter("segue a chave geral, que está na OpenRouter");
}

type ErroDeApi = {
  status?: unknown;
  name?: unknown;
  message?: unknown;
  code?: unknown;
};

/**
 * O motivo da volta, em português, para a execução e para quem a lê.
 *
 * Os códigos são os que o proxy devolve (`errors.ts` dele): 429 é a cota da
 * assinatura, 401 o login vencido, 503 a fila cheia, 504 o teto de tempo dele,
 * 529 a Anthropic sobrecarregada.
 */
export function motivoDaVolta(erro: unknown): string {
  const e = (erro ?? {}) as ErroDeApi;
  const status = typeof e.status === "number" ? e.status : null;
  const nome = typeof e.name === "string" ? e.name : "";

  if (nome === "APIConnectionTimeoutError") return "o proxy demorou demais para responder";
  if (nome === "APIConnectionError") return "não consegui falar com o proxy";

  const porStatus: Record<number, string> = {
    401: "o login da assinatura no proxy está vencido ou foi recusado (401)",
    403: "o proxy recusou a chave (403)",
    429: "a cota da assinatura acabou, ou o proxy limitou as chamadas (429)",
    503: "a fila do proxy estava cheia (503)",
    504: "o proxy estourou o tempo do turno (504)",
    529: "a Anthropic estava sobrecarregada (529)",
  };
  if (status !== null && porStatus[status]) return porStatus[status];

  const detalhe = typeof e.message === "string" ? e.message.slice(0, 200) : String(erro).slice(0, 200);
  return status !== null ? `o proxy respondeu ${status}: ${detalhe}` : `o proxy falhou: ${detalhe}`;
}

export type ChamadaDoModelo<R> = {
  motor: Motor;
  /** Como fica gravado em `AgentRun.model`. */
  modelo: string;
  chamar: () => Promise<R>;
};

export type ResultadoDaChamada<R> = {
  resposta: R;
  motor: Motor;
  modelo: string;
  /** Preenchido quando o proxy falhou e esta resposta veio da OpenRouter. */
  voltaDoProxy: string | null;
};

/**
 * Uma ida ao modelo, com a volta para a OpenRouter.
 *
 * ⚠ **Parada no painel NÃO volta.** Quem clicou em "parar" quer o turno
 * parado; refazer a chamada na OpenRouter entregaria ao cliente justamente a
 * resposta que alguém tentou impedir.
 *
 * Qualquer outra falha do proxy volta — inclusive 400. A condição do usuário é
 * não quebrar o que funciona, e a OpenRouter é o que funciona: um pedido que o
 * proxy recusa por algo dele (formato, ferramenta que ele não lista, contexto)
 * ainda tem a chance de ser atendido lá. Sem OpenRouter configurada, não há para
 * onde voltar, e o erro do proxy sobe como está.
 */
export async function chamarComVolta<R>(args: {
  proxy: ChamadaDoModelo<R> | null;
  openrouter: () => ChamadaDoModelo<R>;
  podeVoltarParaOpenRouter: boolean;
}): Promise<ResultadoDaChamada<R>> {
  if (args.proxy) {
    try {
      const resposta = await args.proxy.chamar();
      return { resposta, motor: args.proxy.motor, modelo: args.proxy.modelo, voltaDoProxy: null };
    } catch (erro) {
      if (ehInterrupcao(erro) || !args.podeVoltarParaOpenRouter) throw erro;
      const volta = motivoDaVolta(erro);
      const openrouter = args.openrouter();
      try {
        const resposta = await openrouter.chamar();
        return { resposta, motor: openrouter.motor, modelo: openrouter.modelo, voltaDoProxy: volta };
      } catch (erroDaVolta) {
        // A volta também falhou: o erro que sobe é o da OpenRouter, que é quem
        // estava respondendo, mas leva junto por que o proxy tinha falhado.
        if (erroDaVolta && typeof erroDaVolta === "object") {
          (erroDaVolta as { voltaDoProxy?: string }).voltaDoProxy = volta;
        }
        throw erroDaVolta;
      }
    }
  }

  const openrouter = args.openrouter();
  const resposta = await openrouter.chamar();
  return { resposta, motor: openrouter.motor, modelo: openrouter.modelo, voltaDoProxy: null };
}
