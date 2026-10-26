import { describe, expect, it } from "vitest";
import {
  custoEquivalente,
  ehModeloClaude,
  normalizarModelo,
  temTarifa,
} from "./precos";

const zero = { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 };

describe("normalizarModelo", () => {
  it("tira o prefixo do provedor e a data de versão", () => {
    expect(normalizarModelo("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizarModelo("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizarModelo("  Claude-Opus-5-5 ")).toBe("claude-opus-5-5");
  });

  it("não mexe em número que faz parte do nome", () => {
    expect(normalizarModelo("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  });
});

describe("ehModeloClaude / temTarifa", () => {
  it("só Claude gasta da conta Claude", () => {
    expect(ehModeloClaude("claude-sonnet-5")).toBe(true);
    expect(ehModeloClaude("anthropic/claude-sonnet-4-6")).toBe(true);
    expect(ehModeloClaude("deepseek/deepseek-v4-flash")).toBe(false);
    expect(ehModeloClaude("delivery-mirror")).toBe(false);
  });

  it("modelo Claude novo, sem linha na tabela, é Claude e não tem tarifa", () => {
    expect(ehModeloClaude("claude-sonnet-9")).toBe(true);
    expect(temTarifa("claude-sonnet-9")).toBe(false);
  });
});

describe("custoEquivalente", () => {
  it("Sonnet 5: US$ 2 de entrada, 10 de saída, 0,20 de cache lido, 2,50 de cache escrito por milhão", () => {
    const custo = custoEquivalente("claude-sonnet-5", {
      entrada: 1_000_000,
      saida: 1_000_000,
      cacheLeitura: 1_000_000,
      cacheEscrita: 1_000_000,
    });
    expect(custo).toBeCloseTo(2 + 10 + 0.2 + 2.5, 6);
  });

  it("Opus 5.5 lê cache a US$ 0,20, não a 10% da entrada", () => {
    expect(
      custoEquivalente("claude-opus-5-5", { ...zero, cacheLeitura: 1_000_000 }),
    ).toBeCloseTo(0.2, 6);
  });

  it("a escrita no cache é 1,25× a entrada de cada modelo", () => {
    expect(
      custoEquivalente("claude-haiku-4-5", { ...zero, cacheEscrita: 1_000_000 }),
    ).toBeCloseTo(1.25, 6);
    expect(
      custoEquivalente("claude-opus-4-6", { ...zero, cacheEscrita: 1_000_000 }),
    ).toBeCloseTo(6.25, 6);
  });

  it("modelo sem tarifa devolve null, e não zero", () => {
    expect(custoEquivalente("deepseek/deepseek-v4-flash", { ...zero, entrada: 5 })).toBeNull();
    expect(custoEquivalente("claude-sonnet-9", { ...zero, entrada: 5 })).toBeNull();
  });

  it("sem uso, o custo é zero (e não null)", () => {
    expect(custoEquivalente("claude-sonnet-5", zero)).toBe(0);
  });

  it("variantes do mesmo modelo custam igual", () => {
    const t = { ...zero, entrada: 1000, saida: 1000 };
    expect(custoEquivalente("anthropic/claude-sonnet-4-6", t)).toBe(
      custoEquivalente("claude-sonnet-4-6", t),
    );
    expect(custoEquivalente("claude-haiku-4-5-20251001", t)).toBe(
      custoEquivalente("claude-haiku-4-5", t),
    );
  });
});
