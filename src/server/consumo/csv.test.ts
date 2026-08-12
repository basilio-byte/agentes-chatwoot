import { describe, expect, it } from "vitest";
import { FUSO_SEAHUB } from "@/lib/tempo";
import { nomeDoArquivo, paraCsv, type LinhaCsv } from "./csv";

function linha(over: Partial<LinhaCsv> = {}): LinhaCsv {
  return {
    createdAt: new Date("2026-08-11T22:52:03Z"),
    agente: "Recepção",
    model: "openai/gpt-5.6-luna",
    source: "CHATWOOT",
    status: "SUCCESS",
    chatwootConversationId: 42,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 800,
    costUsd: 0.0119,
    latencyMs: 5368,
    iterations: 2,
    erro: null,
    ...over,
  };
}

function colunas(csv: string, indiceDaLinha: number) {
  return csv.trimEnd().split("\r\n")[indiceDaLinha].split(";");
}

describe("CSV da apuração", () => {
  it("abre com BOM e cabeçalho", () => {
    const csv = paraCsv([], FUSO_SEAHUB);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("Custo (USD)");
  });

  it("usa a hora de São Paulo, não a do container", () => {
    // 22:52Z é 19:52 em SP, no dia 11 — em UTC já seria quase dia 12.
    expect(colunas(paraCsv([linha()], FUSO_SEAHUB), 1)[0]).toBe(
      "2026-08-11 19:52:03",
    );
  });

  it("escreve o custo com vírgula decimal e seis casas", () => {
    // Duas casas zerariam o custo de um turno barato.
    const c = colunas(paraCsv([linha({ costUsd: 0.0007 })], FUSO_SEAHUB), 1);
    expect(c[9]).toBe("0,000700");
  });

  it("protege o separador dentro do texto", () => {
    const csv = paraCsv(
      [linha({ agente: "Vendas; Sul", erro: 'quebrou "feio"' })],
      FUSO_SEAHUB,
    );
    expect(csv).toContain('"Vendas; Sul"');
    expect(csv).toContain('quebrou ""feio""');
  });

  it("achata quebra de linha do erro numa célula só", () => {
    // Erro de stack trace tem \n; sem achatar, uma execução vira cinco linhas
    // da planilha e a soma da coluna de custo sai errada.
    const csv = paraCsv([linha({ erro: "linha 1\nlinha 2" })], FUSO_SEAHUB);
    expect(csv.trimEnd().split("\r\n")).toHaveLength(2);
    expect(csv).toContain("linha 1 linha 2");
  });

  it("deixa vazio o modelo não registrado, em vez de inventar rótulo", () => {
    expect(colunas(paraCsv([linha({ model: null })], FUSO_SEAHUB), 1)[2]).toBe(
      "",
    );
  });

  it("nomeia o arquivo pelo período", () => {
    expect(nomeDoArquivo("2026-07-13", "2026-08-11")).toBe(
      "consumo-2026-07-13-a-2026-08-11.csv",
    );
    expect(nomeDoArquivo(null, "2026-08-11")).toBe(
      "consumo-ate-2026-08-11.csv",
    );
  });
});
