import { describe, expect, it } from "vitest";
import {
  estimarCusto,
  formatarPrecoMTok,
  type ModeloCatalogo,
} from "./catalogo";

const MODELO: ModeloCatalogo = {
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
};

describe("estimativa de custo", () => {
  it("cobra entrada e saída pelo preço do modelo", () => {
    const custo = estimarCusto(MODELO, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    expect(custo).toBeCloseTo(3.5, 6);
  });

  it("não cobra token cacheado duas vezes", () => {
    // A OpenRouter reporta os tokens cacheados DENTRO de prompt_tokens; cobrar
    // os dois cheios inflaria o custo.
    const custo = estimarCusto(MODELO, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 0,
    });

    expect(custo).toBeCloseTo(0.05, 6);
  });

  it("cache barateia em relação à entrada normal", () => {
    const semCache = estimarCusto(MODELO, {
      inputTokens: 500_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    const comCache = estimarCusto(MODELO, {
      inputTokens: 500_000,
      outputTokens: 0,
      cacheReadTokens: 500_000,
      cacheCreationTokens: 0,
    });

    expect(comCache).toBeLessThan(semCache);
  });

  it("usa 10% da entrada quando o modelo não publica preço de cache", () => {
    const semPrecoDeCache = { ...MODELO, precoCacheLeituraMTok: null };
    const custo = estimarCusto(semPrecoDeCache, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 0,
    });

    expect(custo).toBeCloseTo(0.05, 6);
  });

  it("modelo desconhecido não quebra o registro da execução", () => {
    expect(
      estimarCusto(null, {
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe(0);
  });
});

describe("formatação de preço", () => {
  it("mostra modelo gratuito como grátis", () => {
    expect(formatarPrecoMTok(0)).toBe("grátis");
  });

  it("usa 4 casas para preços muito baixos", () => {
    expect(formatarPrecoMTok(0.003)).toBe("$0.0030");
  });

  it("usa 2 casas para o resto", () => {
    expect(formatarPrecoMTok(1.5)).toBe("$1.50");
  });
});
