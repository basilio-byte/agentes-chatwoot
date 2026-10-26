import { describe, expect, it } from "vitest";
import type { Bloqueio } from "./bloqueios";
import { amostrasDeCota, estimarCota, type AmostraDeCota } from "./calibragem";
import { RESET_PADRAO } from "./ciclo";

const utc = (s: string) => new Date(`${s}Z`);

function bloqueio(inicio: string): Bloqueio {
  return {
    inicio: utc(inicio),
    fim: utc(inicio),
    horas: 10,
    recusas: 40,
    conteineres: ["fkv5"],
    emCurso: false,
  };
}

/** US$ 10 por hora cheia, de `de` (inclusive) a `ate` (exclusive). */
function gastoConstante(de: string, ate: string, usd = 10) {
  const horas: { hora: Date; usd: number }[] = [];
  for (let t = utc(de).getTime(); t < utc(ate).getTime(); t += 3_600_000) {
    horas.push({ hora: new Date(t), usd });
  }
  return horas;
}

const amostra = (usd: number): AmostraDeCota => ({
  cicloInicio: utc("2026-10-04T19:00"),
  bloqueioInicio: utc("2026-10-09T23:00"),
  usd,
});

describe("amostrasDeCota", () => {
  it("soma do reset até a hora da primeira recusa, ela inclusive", () => {
    // Reset 04/10 19h; bloqueio começa 09/10 23h → 124 horas antes dele, mais a hora dele = 125.
    const usoPorHora = gastoConstante("2026-10-04T19:00", "2026-10-11T19:00");
    const [a] = amostrasDeCota([bloqueio("2026-10-09T23:00")], usoPorHora, RESET_PADRAO);
    expect(a.cicloInicio.toISOString()).toBe("2026-10-04T19:00:00.000Z");
    expect(a.usd).toBe(125 * 10);
  });

  it("não conta o gasto do ciclo anterior", () => {
    const usoPorHora = gastoConstante("2026-09-27T19:00", "2026-10-09T23:00");
    const [a] = amostrasDeCota([bloqueio("2026-10-09T23:00")], usoPorHora, RESET_PADRAO);
    // Só as 124 horas do ciclo (04/10 19h a 09/10 22h); as de setembro ficam de fora.
    expect(a.usd).toBe(124 * 10);
  });

  it("dois bloqueios no mesmo ciclo dão uma amostra só (a do primeiro)", () => {
    const usoPorHora = gastoConstante("2026-10-04T19:00", "2026-10-11T19:00");
    const amostras = amostrasDeCota(
      [bloqueio("2026-10-09T23:00"), bloqueio("2026-10-07T10:00")],
      usoPorHora,
      RESET_PADRAO,
    );
    expect(amostras).toHaveLength(1);
    expect(amostras[0].bloqueioInicio.toISOString()).toBe("2026-10-07T10:00:00.000Z");
  });

  it("sem bloqueio não há amostra", () => {
    expect(amostrasDeCota([], gastoConstante("2026-10-04T19:00", "2026-10-11T19:00"), RESET_PADRAO)).toEqual([]);
  });
});

describe("estimarCota", () => {
  it("é a média das amostras, com a faixa", () => {
    const e = estimarCota([amostra(888), amostra(1057), amostra(1221)])!;
    expect(e.usd).toBeCloseTo((888 + 1057 + 1221) / 3, 6);
    expect(e.minimo).toBe(888);
    expect(e.maximo).toBe(1221);
    expect(e.amostras).toHaveLength(3);
    expect(e.descartadas).toHaveLength(0);
  });

  it("descarta o ciclo incompleto (menos da metade da mediana)", () => {
    // O ciclo de 27/09, em que o coletor mal cobria os OpenClaws: US$ 250.
    const e = estimarCota([amostra(250), amostra(1221), amostra(888), amostra(1057)])!;
    expect(e.descartadas.map((a) => a.usd)).toEqual([250]);
    expect(e.usd).toBeCloseTo((1221 + 888 + 1057) / 3, 6);
  });

  it("com uma amostra só, é ela", () => {
    const e = estimarCota([amostra(950)])!;
    expect(e.usd).toBe(950);
    expect(e.minimo).toBe(950);
    expect(e.maximo).toBe(950);
  });

  it("sem amostra, ou só com amostras sem gasto, não estima", () => {
    expect(estimarCota([])).toBeNull();
    expect(estimarCota([amostra(0)])).toBeNull();
  });
});
