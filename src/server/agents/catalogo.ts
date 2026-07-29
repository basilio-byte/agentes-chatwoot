import { logger } from "@/lib/logger";
import { baseUrl } from "./openrouter";

/**
 * Catálogo de modelos da OpenRouter.
 *
 * A lista vem da API pública deles (`/models`, sem autenticação) em vez de uma
 * tabela fixa no código: são ~340 modelos e os preços mudam. Tabela estática
 * ficaria desatualizada em semanas.
 */

export type ModeloCatalogo = {
  id: string;
  nome: string;
  contexto: number;
  maxSaida: number | null;
  /** USD por milhão de tokens. */
  precoEntradaMTok: number;
  precoSaidaMTok: number;
  precoCacheLeituraMTok: number | null;
  /** Sem isto o agente não consegue usar integrações. */
  suportaTools: boolean;
  /** Só nestes o campo `effort` tem efeito. */
  suportaReasoning: boolean;
  gratuito: boolean;
};

export const MODELO_PADRAO = "openai/gpt-5.6-luna";

/**
 * Corta o teto de saída pelo que o modelo realmente aceita.
 *
 * O padrão do agente é alto de propósito — um turno pode encadear
 * transferências e vários usos de tool. Mas pedir mais saída do que o modelo
 * suporta é erro 400 em vários provedores, e aí o cliente fica sem resposta por
 * um número de configuração. Quando o catálogo não sabe o limite, manda como
 * está: a alternativa seria chutar um teto para baixo e truncar resposta boa.
 */
export function limitarSaida(
  desejado: number,
  modelo: Pick<ModeloCatalogo, "maxSaida"> | null | undefined,
): number {
  const teto = modelo?.maxSaida;
  if (!teto || teto <= 0) return desejado;
  return Math.min(desejado, teto);
}

export const EFFORTS = ["none", "low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * Converte um effort guardado para um da lista atual.
 *
 * Existe porque a lista mudou na migração para a OpenRouter: era
 * `low/medium/high/xhigh/max` (Anthropic) e virou `none/low/medium/high`. Linhas
 * antigas ficaram com valores que a interface não conhece — e um `<select>`
 * controlado com valor sem opção correspondente exibe a **primeira** opção e
 * envia ela, gravando `none` sem ninguém pedir.
 */
export function normalizarEffort(valor: string | null | undefined): Effort {
  const alvo = (valor ?? "").toLowerCase().trim();
  if ((EFFORTS as readonly string[]).includes(alvo)) return alvo as Effort;

  // Os dois níveis acima de `high` que existiam antes viram `high`.
  if (alvo === "xhigh" || alvo === "max") return "high";
  return "medium";
}

export const DICAS_EFFORT: Record<Effort, string> = {
  none: "Sem raciocínio extra. Menor latência e custo.",
  low: "Raciocínio curto. Bom para perguntas diretas.",
  medium: "Equilíbrio para atendimento conversacional.",
  high: "Raciocínio longo. Use quando a resposta exigir análise.",
};

/**
 * Usado só quando a API da OpenRouter está inacessível — o painel continua
 * funcionando em vez de mostrar um seletor vazio.
 */
const FALLBACK: ModeloCatalogo[] = [
  {
    id: "openai/gpt-5.6-luna",
    nome: "OpenAI: GPT-5.6 Luna",
    contexto: 1_050_000,
    maxSaida: null,
    precoEntradaMTok: 0.5,
    precoSaidaMTok: 3,
    precoCacheLeituraMTok: 0.05,
    suportaTools: true,
    suportaReasoning: true,
    gratuito: false,
  },
  {
    id: "google/gemini-3.5-flash",
    nome: "Google: Gemini 3.5 Flash",
    contexto: 1_048_576,
    maxSaida: null,
    precoEntradaMTok: 1.5,
    precoSaidaMTok: 9,
    precoCacheLeituraMTok: 0.15,
    suportaTools: true,
    suportaReasoning: true,
    gratuito: false,
  },
  {
    id: "deepseek/deepseek-v4-flash",
    nome: "DeepSeek: V4 Flash",
    contexto: 1_048_576,
    maxSaida: null,
    precoEntradaMTok: 0.14,
    precoSaidaMTok: 0.28,
    precoCacheLeituraMTok: 0.028,
    suportaTools: true,
    suportaReasoning: true,
    gratuito: false,
  },
];

type RespostaOpenRouter = {
  data: Array<{
    id: string;
    name: string;
    context_length: number;
    pricing: {
      prompt: string;
      completion: string;
      input_cache_read?: string | null;
    };
    top_provider?: { max_completion_tokens?: number | null };
    supported_parameters?: string[];
  }>;
};

const TTL_MS = 60 * 60 * 1000; // 1h
let cache: { modelos: ModeloCatalogo[]; expiraEm: number } | null = null;

export async function listarModelos(): Promise<ModeloCatalogo[]> {
  if (cache && cache.expiraEm > Date.now()) return cache.modelos;

  try {
    const resposta = await fetch(`${baseUrl()}/models`, {
      // Endpoint público — não manda a chave de propósito.
      signal: AbortSignal.timeout(10_000),
    });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);

    const corpo = (await resposta.json()) as RespostaOpenRouter;
    const modelos = corpo.data
      .map(mapear)
      .sort((a, b) => a.id.localeCompare(b.id));

    cache = { modelos, expiraEm: Date.now() + TTL_MS };
    return modelos;
  } catch (erro) {
    logger.warn(
      { erro: erro instanceof Error ? erro.message : erro },
      "não foi possível listar modelos da OpenRouter — usando lista de reserva",
    );
    return FALLBACK;
  }
}

function mapear(bruto: RespostaOpenRouter["data"][number]): ModeloCatalogo {
  const params = bruto.supported_parameters ?? [];
  const porMTok = (valor?: string | null) =>
    valor == null || valor === "" ? null : Number(valor) * 1_000_000;

  const entrada = porMTok(bruto.pricing.prompt) ?? 0;
  const saida = porMTok(bruto.pricing.completion) ?? 0;

  return {
    id: bruto.id,
    nome: bruto.name,
    contexto: bruto.context_length,
    maxSaida: bruto.top_provider?.max_completion_tokens ?? null,
    precoEntradaMTok: entrada,
    precoSaidaMTok: saida,
    precoCacheLeituraMTok: porMTok(bruto.pricing.input_cache_read),
    suportaTools: params.includes("tools"),
    suportaReasoning:
      params.includes("reasoning") || params.includes("reasoning_effort"),
    gratuito: entrada === 0 && saida === 0,
  };
}

export async function obterModelo(id: string): Promise<ModeloCatalogo | null> {
  const modelos = await listarModelos();
  return modelos.find((m) => m.id === id) ?? null;
}

export type UsoTokens = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

/**
 * Custo estimado a partir da tabela de preços.
 *
 * Só é usado quando a OpenRouter não devolve `usage.cost` na resposta — o valor
 * dela é o real cobrado e tem precedência (ver `runner.ts`).
 */
export function estimarCusto(modelo: ModeloCatalogo | null, uso: UsoTokens) {
  if (!modelo) return 0;

  const entradaNaoCacheada = Math.max(
    0,
    uso.inputTokens - uso.cacheReadTokens,
  );
  const precoCache =
    modelo.precoCacheLeituraMTok ?? modelo.precoEntradaMTok * 0.1;

  return (
    (entradaNaoCacheada * modelo.precoEntradaMTok) / 1_000_000 +
    (uso.cacheReadTokens * precoCache) / 1_000_000 +
    (uso.outputTokens * modelo.precoSaidaMTok) / 1_000_000
  );
}

export function formatarPrecoMTok(valor: number) {
  if (valor === 0) return "grátis";
  if (valor < 0.01) return `$${valor.toFixed(4)}`;
  return `$${valor.toFixed(2)}`;
}
