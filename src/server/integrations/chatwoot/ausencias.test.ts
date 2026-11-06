import { describe, expect, it } from "vitest";
import {
  ausenciaVigente,
  ausenciasDaConfig,
  ausenciasEmTexto,
  dataBR,
  lerAusenciasDoTexto,
  MAXIMO_DE_AUSENCIAS,
} from "./ausencias";

const FERIAS = { nome: "Laercio", substituto: "Felipe", ate: "2026-11-19" };

describe("lerAusenciasDoTexto", () => {
  it("lê 'nome -> substituto até dd/mm/aaaa' e guarda a data em ISO", () => {
    expect(lerAusenciasDoTexto("Laercio -> Felipe até 19/11/2026")).toEqual({
      ausencias: [FERIAS],
    });
  });

  it("aceita a data em ISO, a seta de texto e 'ate' sem acento", () => {
    expect(lerAusenciasDoTexto("Laercio → Felipe ate 2026-11-19")).toEqual({ ausencias: [FERIAS] });
    expect(lerAusenciasDoTexto("Laercio => Felipe ATÉ 19/11/2026")).toEqual({ ausencias: [FERIAS] });
  });

  it("aceita nome completo e várias linhas, ignorando as em branco", () => {
    const r = lerAusenciasDoTexto(
      "Laércio Melo -> Felipe Fragoso até 19/11/2026\r\n\r\nAlan -> Kelly até 30/11/2026\n",
    );
    expect(r).toEqual({
      ausencias: [
        { nome: "Laércio Melo", substituto: "Felipe Fragoso", ate: "2026-11-19" },
        { nome: "Alan", substituto: "Kelly", ate: "2026-11-30" },
      ],
    });
  });

  it("texto vazio é 'nenhuma ausência' — é como se limpa a lista", () => {
    expect(lerAusenciasDoTexto("")).toEqual({ ausencias: [] });
    expect(lerAusenciasDoTexto("  \n  ")).toEqual({ ausencias: [] });
  });

  it("recusa linha fora do formato, dizendo QUAL é", () => {
    const r = lerAusenciasDoTexto("Laercio -> Felipe até 19/11/2026\nsó o Laercio");
    expect(r).toMatchObject({ erro: expect.stringContaining("linha 2") });
  });

  it("⚠ recusa data que não existe: 31/02 não vira 'sem prazo'", () => {
    const r = lerAusenciasDoTexto("Laercio -> Felipe até 31/02/2026");
    expect(r).toMatchObject({ erro: expect.stringContaining("não existe") });
  });

  it("recusa a pessoa como substituta de si mesma, ignorando acento e caixa", () => {
    expect(lerAusenciasDoTexto("Laércio -> laercio até 19/11/2026")).toMatchObject({
      erro: expect.stringContaining("próprio substituto"),
    });
  });

  it("recusa a mesma pessoa em duas linhas: não há como saber qual vale", () => {
    const r = lerAusenciasDoTexto(
      "Laercio -> Felipe até 19/11/2026\nLaércio -> Alan até 30/11/2026",
    );
    expect(r).toMatchObject({ erro: expect.stringContaining("já aparece") });
  });

  it("tem teto de linhas", () => {
    const muitas = Array.from(
      { length: MAXIMO_DE_AUSENCIAS + 1 },
      (_, i) => `Pessoa${i} -> Outra${i} até 19/11/2026`,
    ).join("\n");
    expect(lerAusenciasDoTexto(muitas)).toMatchObject({ erro: expect.stringContaining("no máximo") });
  });
});

describe("ausenciaVigente", () => {
  it("vale até o FIM do último dia: no dia 'ate' ainda vale, no seguinte não", () => {
    expect(ausenciaVigente(FERIAS, "2026-11-06")).toBe(true);
    expect(ausenciaVigente(FERIAS, "2026-11-19")).toBe(true);
    expect(ausenciaVigente(FERIAS, "2026-11-20")).toBe(false);
  });
});

describe("ausenciasDaConfig", () => {
  it("lê as ausências da configuração do Chatwoot", () => {
    expect(ausenciasDaConfig({ baseUrl: "x", accountId: 1, ausencias: [FERIAS] })).toEqual([FERIAS]);
  });

  it("config antiga, vazia ou torta não derruba nada: sem ausências", () => {
    expect(ausenciasDaConfig(undefined)).toEqual([]);
    expect(ausenciasDaConfig(null)).toEqual([]);
    expect(ausenciasDaConfig({ baseUrl: "x", accountId: 1 })).toEqual([]);
    expect(ausenciasDaConfig({ ausencias: "texto" })).toEqual([]);
  });

  it("uma linha inválida é ignorada e as outras valem", () => {
    const bruta = { ausencias: [{ nome: "A", substituto: "B", ate: "ontem" }, FERIAS] };
    expect(ausenciasDaConfig(bruta)).toEqual([FERIAS]);
  });
});

describe("texto da tela", () => {
  it("ida e volta: o que a tela mostra é o que ela lê", () => {
    const texto = ausenciasEmTexto([FERIAS]);
    expect(texto).toBe("Laercio -> Felipe até 19/11/2026");
    expect(lerAusenciasDoTexto(texto)).toEqual({ ausencias: [FERIAS] });
  });

  it("dataBR", () => {
    expect(dataBR("2026-11-19")).toBe("19/11/2026");
  });
});
