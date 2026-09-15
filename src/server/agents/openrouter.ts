import OpenAI from "openai";
import { env } from "@/lib/env";

const PADRAO = "https://openrouter.ai/api/v1";

/** Endpoint em uso. `OPENROUTER_BASE_URL` sobrescreve (testes, proxy interno). */
export function baseUrl(): string {
  return env().OPENROUTER_BASE_URL ?? PADRAO;
}

let cliente: OpenAI | null = null;

/**
 * Cliente da OpenRouter.
 *
 * A OpenRouter fala o protocolo de chat completions da OpenAI, então usamos o
 * SDK oficial da OpenAI apontado para o endpoint dela. A chave é opcional no
 * boot para o painel subir sem ela; a exigência aparece aqui.
 */
export function getOpenRouter(): OpenAI {
  const apiKey = env().OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY não configurada. Defina no .env (local) ou nas variáveis de ambiente do Easypanel.",
    );
  }

  cliente ??= new OpenAI({
    apiKey,
    baseURL: baseUrl(),
    // Cabeçalhos de atribuição da OpenRouter — aparecem no ranking público
    // deles e ajudam no suporte. Opcionais.
    defaultHeaders: {
      "HTTP-Referer": env().OPENROUTER_SITE_URL ?? "https://seahub.com.br",
      "X-Title": env().OPENROUTER_SITE_NAME ?? "Seahub Agentes",
    },
  });

  return cliente;
}

export function openrouterConfigurada(): boolean {
  return Boolean(env().OPENROUTER_API_KEY);
}

/**
 * Como a OpenRouter escolhe o provedor de cada chamada: pelo mais RÁPIDO.
 *
 * ⚠ Sem isto, ela sorteia entre os provedores estáveis com peso pelo inverso do
 * quadrado do preço — o mais barato leva quase tudo. O kimi-k2.6 tem 21
 * provedores, vários comprimidos (int4/fp4) e alguns degradados, e em 14 e
 * 15/09/2026 uma ida só ao modelo levou 219 s e 478 s, acima dos 3 minutos do
 * vigia, uma delas na porta de entrada. Decisão do usuário em 15/09/2026:
 * priorizar vazão, aceitando pagar até ~1,7× por chamada.
 *
 * Os fallbacks continuam no padrão (ligados): se o mais rápido falhar, outro
 * atende. Excluir quantização ficou para depois de medir o efeito disto.
 */
export const PREFERENCIA_DE_PROVEDOR = { sort: "throughput" } as const;
