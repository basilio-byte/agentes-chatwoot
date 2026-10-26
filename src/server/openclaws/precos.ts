/**
 * Custo EQUIVALENTE dos modelos Claude: a tarifa pública da API aplicada ao
 * que o OpenClaw consumiu.
 *
 * ⚠ **Não é fatura.** Os OpenClaws gastam de uma assinatura, que não cobra por
 * token. A tarifa serve de RÉGUA comum — Opus, Sonnet e Haiku não se comparam em
 * "tokens" — e de base para estimar a cota semanal (`calibragem.ts`). A
 * Anthropic não publica o peso que a cota dá a cada tipo de token, então
 * qualquer número em US$ aqui é estimativa, e a tela diz isso.
 *
 * Tarifa de 06/10/2026, em US$ por milhão de tokens. Escrita no cache é a de 5
 * minutos (1,25× a entrada): é a que o OpenClaw usa. Modelo sem linha aqui NÃO
 * ganha custo chutado — vira "sem tarifa", e a tela mostra quantas chamadas
 * ficaram de fora da conta.
 */
type Tarifa = { entrada: number; saida: number; leitura: number };

const TARIFAS: Record<string, Tarifa> = {
  "claude-fable-5-1": { entrada: 10, saida: 50, leitura: 0.25 },
  "claude-fable-5": { entrada: 10, saida: 50, leitura: 0.25 },
  "claude-opus-5-5": { entrada: 4, saida: 20, leitura: 0.2 },
  "claude-opus-5": { entrada: 5, saida: 25, leitura: 0.5 },
  "claude-opus-4-8": { entrada: 5, saida: 25, leitura: 0.5 },
  "claude-opus-4-7": { entrada: 5, saida: 25, leitura: 0.5 },
  "claude-opus-4-6": { entrada: 5, saida: 25, leitura: 0.5 },
  "claude-sonnet-5-5": { entrada: 2, saida: 10, leitura: 0.2 },
  "claude-sonnet-5": { entrada: 2, saida: 10, leitura: 0.2 },
  "claude-sonnet-4-6": { entrada: 3, saida: 15, leitura: 0.3 },
  "claude-haiku-5-5": { entrada: 0.1, saida: 0.5, leitura: 0.01 },
  "claude-haiku-4-5": { entrada: 1, saida: 5, leitura: 0.1 },
};

/** Escrita no cache (TTL de 5 min) = 1,25× a entrada. */
const FATOR_DA_ESCRITA = 1.25;

export type Tokens = {
  entrada: number;
  saida: number;
  cacheLeitura: number;
  cacheEscrita: number;
};

/**
 * `anthropic/claude-sonnet-4-6` e `claude-haiku-4-5-20251001` são os mesmos
 * modelos de `claude-sonnet-4-6` e `claude-haiku-4-5`: o OpenClaw grava o nome
 * como o provedor devolveu, com prefixo e data de versão.
 */
export function normalizarModelo(modelo: string): string {
  return modelo
    .trim()
    .toLowerCase()
    .replace(/^anthropic\//, "")
    .replace(/-\d{8}$/, "");
}

/** Gasta da conta Claude? `deepseek/…` vai pela OpenRouter, outra fatura. */
export function ehModeloClaude(modelo: string): boolean {
  return normalizarModelo(modelo).startsWith("claude-");
}

export function temTarifa(modelo: string): boolean {
  return normalizarModelo(modelo) in TARIFAS;
}

/**
 * Custo equivalente em US$, ou `null` quando não há tarifa para o modelo.
 * `null` e zero são coisas diferentes: zero é "não gastou", `null` é "não sei".
 */
export function custoEquivalente(modelo: string, tokens: Tokens): number | null {
  const tarifa = TARIFAS[normalizarModelo(modelo)];
  if (!tarifa) return null;
  return (
    (tokens.entrada * tarifa.entrada +
      tokens.saida * tarifa.saida +
      tokens.cacheLeitura * tarifa.leitura +
      tokens.cacheEscrita * tarifa.entrada * FATOR_DA_ESCRITA) /
    1_000_000
  );
}
