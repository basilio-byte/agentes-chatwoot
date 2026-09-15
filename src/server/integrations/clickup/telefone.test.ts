import { describe, expect, it } from "vitest";
import { mesmoTelefone, variacoesDoTelefone } from "./telefone";

// Números fictícios. Os formatos são os que existem nos CRMs (15/09/2026):
// "+55 DD NNNNNNNNN", "DD NNNNNNNNN" e o do WhatsApp, sem o nono dígito.

describe("variacoesDoTelefone", () => {
  it("celular que chega do WhatsApp sem o nono dígito também é buscado com ele", () => {
    const formas = variacoesDoTelefone("+558487654321");

    expect(formas).toContain("+55 84 987654321");
    expect(formas).toContain("+55 84 98765 4321");
    expect(formas).toContain("84 987654321");
    expect(formas).toContain("+55 84 87654321");
    expect(formas).toContain("5584987654321");
  });

  it("com o nono dígito, busca também sem ele", () => {
    const formas = variacoesDoTelefone("5584987654321");

    expect(formas).toContain("84 987654321");
    expect(formas).toContain("84 87654321");
    expect(formas).toContain("+55 84 98765-4321");
  });

  it("aceita o número já formatado, com parêntese e traço", () => {
    expect(variacoesDoTelefone("(84) 98765-4321")).toContain("+55 84 987654321");
  });

  it("telefone fixo não ganha nono dígito", () => {
    const formas = variacoesDoTelefone("+55 84 3212-3456");

    expect(formas).toContain("+55 84 32123456");
    expect(formas.some((f) => f.includes("932123456"))).toBe(false);
  });

  it("o que não é número brasileiro com DDD não gera busca", () => {
    expect(variacoesDoTelefone("12345")).toEqual([]);
    expect(variacoesDoTelefone("sem telefone")).toEqual([]);
  });

  it("não repete forma", () => {
    const formas = variacoesDoTelefone("+558487654321");
    expect(new Set(formas).size).toBe(formas.length);
  });
});

describe("mesmoTelefone", () => {
  it("o formato gravado no CRM e o do WhatsApp são o mesmo número", () => {
    expect(mesmoTelefone("+55 84 987654321", "+558487654321")).toBe(true);
    expect(mesmoTelefone("(84) 98765-4321", "5584987654321")).toBe(true);
  });

  it("⚠ trecho igual não basta: DDD diferente é outra pessoa", () => {
    // O filtro da API casa trecho — "987654321" acha as duas.
    expect(mesmoTelefone("+55 11 987654321", "+55 84 987654321")).toBe(false);
    expect(mesmoTelefone("+55 84 987654321", "987654321")).toBe(false);
  });

  it("fixo não vira celular", () => {
    expect(mesmoTelefone("+55 84 3212-3456", "8432123456")).toBe(true);
    expect(mesmoTelefone("84 3212 3456", "84 932123456")).toBe(false);
  });

  it("campo vazio ou lixo nunca confere", () => {
    expect(mesmoTelefone("", "")).toBe(false);
    expect(mesmoTelefone("sem telefone", "sem telefone")).toBe(false);
  });
});
