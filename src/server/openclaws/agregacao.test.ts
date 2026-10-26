import { describe, expect, it } from "vitest";
import {
  serieDiaria,
  tokensProcessados,
  totalizar,
  totalizarPor,
  usdPorHora,
  type LinhaDeUso,
} from "./agregacao";

const utc = (s: string) => new Date(`${s}Z`);

function uso(parcial: Partial<LinhaDeUso> = {}): LinhaDeUso {
  return {
    hora: utc("2026-10-20T12:00"),
    conteiner: "lr9a",
    agente: "main",
    tipo: "main",
    modelo: "claude-sonnet-5",
    chamadas: 1,
    entrada: 0,
    saida: 0,
    cacheLeitura: 0,
    cacheEscrita: 0,
    ...parcial,
  };
}

describe("totalizar", () => {
  it("soma tokens, chamadas e o custo equivalente", () => {
    const t = totalizar([
      uso({ chamadas: 2, entrada: 1_000_000, saida: 100_000 }),
      uso({ chamadas: 3, cacheEscrita: 1_000_000 }),
    ]);
    expect(t.chamadas).toBe(5);
    // 1M entrada = US$ 2; 100k saída = US$ 1; 1M escrita = US$ 2,50.
    expect(t.usd).toBeCloseTo(2 + 1 + 2.5, 6);
    expect(tokensProcessados(t)).toBe(1_000_000 + 100_000 + 1_000_000);
  });

  it("modelo de outra fatura entra nos tokens e fora do custo", () => {
    const t = totalizar([
      uso({ modelo: "deepseek/deepseek-v4-flash", chamadas: 14, entrada: 100_000 }),
    ]);
    expect(t.usd).toBe(0);
    expect(t.chamadasForaDaConta).toBe(14);
    expect(t.chamadasSemTarifa).toBe(0);
    expect(t.entrada).toBe(100_000);
  });

  it("modelo Claude sem tarifa fica FORA do custo e é contado à parte", () => {
    const t = totalizar([uso({ modelo: "claude-sonnet-9", chamadas: 7, entrada: 5_000_000 })]);
    expect(t.usd).toBe(0);
    expect(t.chamadasSemTarifa).toBe(7);
  });

  it("lista vazia dá tudo zero", () => {
    expect(totalizar([])).toEqual({
      chamadas: 0,
      entrada: 0,
      saida: 0,
      cacheLeitura: 0,
      cacheEscrita: 0,
      usd: 0,
      chamadasSemTarifa: 0,
      chamadasForaDaConta: 0,
    });
  });
});

describe("totalizarPor", () => {
  it("agrupa pela chave dada", () => {
    const mapa = totalizarPor(
      [
        uso({ conteiner: "lr9a", chamadas: 2 }),
        uso({ conteiner: "fkv5", chamadas: 5 }),
        uso({ conteiner: "lr9a", chamadas: 1 }),
      ],
      (l) => l.conteiner,
    );
    expect(mapa.get("lr9a")?.chamadas).toBe(3);
    expect(mapa.get("fkv5")?.chamadas).toBe(5);
  });
});

describe("usdPorHora", () => {
  it("soma por hora, em ordem, e ignora o que não tem custo", () => {
    const horas = usdPorHora([
      uso({ hora: utc("2026-10-20T13:00"), entrada: 1_000_000 }),
      uso({ hora: utc("2026-10-20T12:00"), entrada: 1_000_000 }),
      uso({ hora: utc("2026-10-20T12:00"), entrada: 500_000 }),
      uso({ hora: utc("2026-10-20T12:00"), modelo: "deepseek/x", entrada: 9_000_000 }),
    ]);
    expect(horas.map((h) => h.hora.toISOString())).toEqual([
      "2026-10-20T12:00:00.000Z",
      "2026-10-20T13:00:00.000Z",
    ]);
    expect(horas[0].usd).toBeCloseTo(3, 6);
    expect(horas[1].usd).toBeCloseTo(2, 6);
  });
});

describe("serieDiaria", () => {
  it("o dia é o de São Paulo: 02:00 UTC ainda é a noite do dia anterior", () => {
    const pontos = serieDiaria(
      [
        uso({ hora: utc("2026-10-21T02:00"), entrada: 1_000_000 }),
        uso({ hora: utc("2026-10-21T12:00"), entrada: 1_000_000 }),
      ],
      ["2026-10-20", "2026-10-21"],
    );
    expect(pontos[0]).toMatchObject({ dia: "2026-10-20", execucoes: 1 });
    expect(pontos[1]).toMatchObject({ dia: "2026-10-21", execucoes: 1 });
  });

  it("dia sem uso aparece como zero", () => {
    const pontos = serieDiaria([], ["2026-10-20", "2026-10-21"]);
    expect(pontos).toEqual([
      { dia: "2026-10-20", custoUsd: 0, execucoes: 0, tokens: 0 },
      { dia: "2026-10-21", custoUsd: 0, execucoes: 0, tokens: 0 },
    ]);
  });

  it("uso fora dos dias pedidos não entra", () => {
    const pontos = serieDiaria([uso({ hora: utc("2026-10-10T12:00"), entrada: 9 })], ["2026-10-20"]);
    expect(pontos[0].execucoes).toBe(0);
  });
});
