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
