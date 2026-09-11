import { describe, expect, it } from "vitest";
import { aplicarAlteracao, carimbo, normalizarQuebras } from "./prompt";

const BASE = [
  "Você é o agente de suporte.",
  "Regra 1: responda curto.",
  "Regra 2: nunca invente preço.",
].join("\n");

describe("carimbo", () => {
  it("é determinístico, curto e muda com um caractere", () => {
    expect(carimbo(BASE)).toMatch(/^[0-9a-f]{16}$/);
    expect(carimbo(BASE)).toBe(carimbo(BASE));
    expect(carimbo(BASE)).not.toBe(carimbo(`${BASE}.`));
  });
});

describe("alteração por substituições", () => {
  it("troca o trecho que aparece uma vez", () => {
    const r = aplicarAlteracao(BASE, {
      tipo: "substituicoes",
      substituicoes: [{ trecho: "responda curto", por: "responda em até três parágrafos" }],
    });
    expect(r.ok && r.prompt).toContain("responda em até três parágrafos");
  });

  it("recusa trecho que não existe, sem aplicar as outras", () => {
    // O pior desfecho seria a primeira troca entrar e a segunda sumir calada.
    const r = aplicarAlteracao(BASE, {
      tipo: "substituicoes",
      substituicoes: [
        { trecho: "Regra 1", por: "Regra A" },
        { trecho: "Regra 99", por: "Regra Z" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.erro).toMatch(/Substituição 2/);
  });

  it("recusa trecho ambíguo em vez de trocar todos", () => {
    const r = aplicarAlteracao(BASE, {
      tipo: "substituicoes",
      substituicoes: [{ trecho: "Regra", por: "Norma" }],
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.erro).toMatch(/2 vezes/);
  });

  it("não interpreta $& nem $1 no texto novo", () => {
    const r = aplicarAlteracao(BASE, {
      tipo: "substituicoes",
      substituicoes: [{ trecho: "nunca invente preço", por: "o plano custa $& ou $1" }],
    });
    expect(r.ok && r.prompt).toContain("o plano custa $& ou $1");
  });

  it("acha trecho com \\n num prompt salvo com \\r\\n, e mantém o \\r\\n", () => {
    // O painel salva a quebra do textarea como CRLF; o assistente escreve LF.
    const crlf = BASE.replace(/\n/g, "\r\n");
    const r = aplicarAlteracao(crlf, {
      tipo: "substituicoes",
      substituicoes: [{ trecho: "curto.\nRegra 2", por: "curto.\nRegra 1b: cumprimente.\nRegra 2" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prompt).toContain("Regra 1b: cumprimente.\r\nRegra 2");
    expect(r.prompt.replace(/\r\n/g, "")).not.toContain("\n");
    expect(r.antes).toBe(BASE);
  });
});

describe("alteração pelo prompt inteiro", () => {
  it("converte para o estilo de quebra do prompt existente", () => {
    const crlf = BASE.replace(/\n/g, "\r\n");
    const r = aplicarAlteracao(crlf, { tipo: "inteiro", novoPrompt: `${BASE}\nRegra 3: seja gentil.` });
    expect(r.ok && r.prompt.endsWith("\r\nRegra 3: seja gentil.")).toBe(true);
  });

  it("o diff compara textos normalizados, não bytes", () => {
    const crlf = BASE.replace(/\n/g, "\r\n");
    const r = aplicarAlteracao(crlf, { tipo: "inteiro", novoPrompt: BASE });
    expect(r.ok && r.antes === r.depois).toBe(true);
    expect(normalizarQuebras("a\r\nb\rc")).toBe("a\nb\nc");
  });
});
