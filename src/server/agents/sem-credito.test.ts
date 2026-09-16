import { describe, expect, it } from "vitest";
import {
  ehSemCredito,
  marcarSemCredito,
  MARCA_SEM_CREDITO,
} from "./sem-credito";

describe("reconhecer falta de crédito", () => {
  it("reconhece pelo status do SDK", () => {
    // É assim que o erro chega do SDK da OpenAI: `status` com o código HTTP.
    expect(ehSemCredito(Object.assign(new Error("402 Payment Required"), { status: 402 }))).toBe(true);
  });

  it("reconhece pela mensagem quando o erro chega reembrulhado", () => {
    expect(
      ehSemCredito(
        new Error(
          '402 {"error":{"message":"Insufficient credits. Add more credits...","code":402}}',
        ),
      ),
    ).toBe(true);
  });

  it("reconhece a própria marca, para o erro já marcado", () => {
    expect(ehSemCredito(new Error(marcarSemCredito("qualquer coisa")))).toBe(true);
  });

  it("não confunde com outros erros HTTP", () => {
    expect(ehSemCredito(Object.assign(new Error("429"), { status: 429 }))).toBe(false);
    expect(ehSemCredito(new Error("503 no available model provider"))).toBe(false);
  });

  it("não casa com 402 solto, sem falar de crédito", () => {
    // Um "402" pode aparecer em nome de modelo ou dentro de retorno de tool;
    // tratar isso como falta de saldo faria o worker desistir de tentar de novo.
    expect(ehSemCredito(new Error("a tarefa 402 não existe na lista"))).toBe(false);
  });

  it("não quebra com valores que não são erro", () => {
    expect(ehSemCredito(null)).toBe(false);
    expect(ehSemCredito(undefined)).toBe(false);
    expect(ehSemCredito("402 insufficient credits")).toBe(false);
  });
});

describe("marca no registro da execução", () => {
  it("preserva a mensagem original", () => {
    const marcada = marcarSemCredito("402 insufficient credits");
    expect(marcada.startsWith(MARCA_SEM_CREDITO)).toBe(true);
    expect(marcada).toContain("402 insufficient credits");
  });

  it("não marca duas vezes", () => {
    const uma = marcarSemCredito("402 insufficient credits");
    expect(marcarSemCredito(uma)).toBe(uma);
  });
});
