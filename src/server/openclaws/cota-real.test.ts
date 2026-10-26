import { describe, expect, it } from "vitest";
import { RESET_PADRAO } from "./ciclo";
import {
  calibrarPelasLeituras,
  cotaRealMaisRecente,
  rotuloDaJanela,
  utilizacaoSemanalNoCiclo,
  type LeituraDeCota,
} from "./cota-real";

const utc = (s: string) => new Date(`${s}Z`);

function leitura(
  lidaEm: string,
  janela: string,
  utilizacao: number,
  resetaEm: string | null = null,
  plano: string | null = "max",
): LeituraDeCota {
  return { lidaEm: utc(lidaEm), janela, utilizacao, resetaEm: resetaEm ? utc(resetaEm) : null, plano };
}

describe("cotaRealMaisRecente", () => {
  const agora = utc("2026-10-26T14:30");

  it("sem leitura, não há cota real", () => {
    expect(cotaRealMaisRecente([], agora)).toBeNull();
  });

  it("pega só as janelas da leitura mais nova, semana primeiro", () => {
    const c = cotaRealMaisRecente(
      [
        leitura("2026-10-26T10:07", "seven_day", 3),
        leitura("2026-10-26T12:07", "five_hour", 11, "2026-10-26T15:00"),
        leitura("2026-10-26T12:07", "seven_day", 5, "2026-11-01T19:00"),
        leitura("2026-10-26T12:07", "seven_day_opus", 0),
      ],
      agora,
    )!;
    expect(c.lidaEm.toISOString()).toBe("2026-10-26T12:07:00.000Z");
    expect(c.janelas.map((j) => j.janela)).toEqual(["seven_day", "five_hour", "seven_day_opus"]);
    expect(c.semanal?.utilizacao).toBe(5);
    expect(c.cincoHoras?.utilizacao).toBe(11);
    expect(c.plano).toBe("max");
    expect(c.atrasada).toBe(false);
  });

  it("leitura de mais de 6 horas está atrasada", () => {
    const c = cotaRealMaisRecente([leitura("2026-10-26T07:00", "seven_day", 5)], agora)!;
    expect(c.atrasada).toBe(true);
  });

  it("janela que o plano não informa fica como null, não como zero", () => {
    const c = cotaRealMaisRecente([leitura("2026-10-26T12:07", "five_hour", 11)], agora)!;
    expect(c.semanal).toBeNull();
    expect(c.cincoHoras).not.toBeNull();
  });
});

describe("rotuloDaJanela", () => {
  it("traduz as janelas conhecidas e deixa a chave quando não conhece", () => {
    expect(rotuloDaJanela("five_hour")).toBe("Janela de 5 horas");
    expect(rotuloDaJanela("seven_day")).toBe("Semana (todos os modelos)");
    expect(rotuloDaJanela("model:fable")).toBe("Semana · fable");
    expect(rotuloDaJanela("coisa_nova")).toBe("coisa_nova");
  });
});

describe("utilizacaoSemanalNoCiclo", () => {
  const ciclo = { inicio: utc("2026-10-18T19:00"), fim: utc("2026-10-25T19:00") };

  it("é o maior percentual semanal lido dentro do ciclo", () => {
    const leituras = [
      leitura("2026-10-19T10:00", "seven_day", 12),
      leitura("2026-10-22T14:00", "seven_day", 100),
      leitura("2026-10-22T14:00", "five_hour", 100),
      leitura("2026-10-26T10:00", "seven_day", 2),
    ];
    expect(utilizacaoSemanalNoCiclo(leituras, ciclo)).toBe(100);
  });

  it("sem leitura no ciclo, null (a tela usa a estimativa)", () => {
    expect(utilizacaoSemanalNoCiclo([leitura("2026-10-26T10:00", "seven_day", 2)], ciclo)).toBeNull();
  });
});

describe("calibrarPelasLeituras", () => {
  /** US$ 10 por hora, a partir de `de` (inclusive) por `horas` horas. */
  function gasto(de: string, horas: number, usd = 10) {
    return Array.from({ length: horas }, (_, i) => ({
      hora: new Date(utc(de).getTime() + i * 3_600_000),
      usd,
    }));
  }

  it("divide o gasto desde o reset pela utilização que a Anthropic mediu", () => {
    // Ciclo começa domingo 25/10 19h. As 18 linhas vão de 19h de domingo até 12h de segunda — a
    // hora da própria leitura (12:07) entra — e somam US$ 180.
    const usoPorHora = gasto("2026-10-25T19:00", 18);
    const c = calibrarPelasLeituras([leitura("2026-10-26T12:07", "seven_day", 18)], usoPorHora, RESET_PADRAO)!;
    // US$ 180 em 18% da semana → 100% = US$ 1.000.
    expect(c.usd).toBeCloseTo(1000, 6);
    expect(c.leituras).toBe(1);
  });

  it("ignora leitura abaixo de 5%: arredondamento demais para dividir", () => {
    const usoPorHora = gasto("2026-10-25T19:00", 18);
    expect(calibrarPelasLeituras([leitura("2026-10-26T12:07", "seven_day", 2)], usoPorHora, RESET_PADRAO)).toBeNull();
  });

  it("só olha a janela da semana", () => {
    const usoPorHora = gasto("2026-10-25T19:00", 18);
    expect(calibrarPelasLeituras([leitura("2026-10-26T12:07", "five_hour", 50)], usoPorHora, RESET_PADRAO)).toBeNull();
  });

  it("usa a mediana: uma leitura fora do padrão não puxa a cota", () => {
    const usoPorHora = gasto("2026-10-25T19:00", 40);
    const c = calibrarPelasLeituras(
      [
        leitura("2026-10-26T12:07", "seven_day", 18), // 180 / 0,18 = 1000
        leitura("2026-10-26T14:07", "seven_day", 22), // 200 / 0,22 = 909
        leitura("2026-10-26T16:07", "seven_day", 90), // 220 / 0,90 = 244 (a conta teve consumo de fora)
      ],
      usoPorHora,
      RESET_PADRAO,
    )!;
    expect(c.leituras).toBe(3);
    expect(c.usd).toBeCloseTo(909.09, 1);
  });

  it("sem gasto registrado, não calibra", () => {
    expect(calibrarPelasLeituras([leitura("2026-10-26T12:07", "seven_day", 18)], [], RESET_PADRAO)).toBeNull();
  });
});
