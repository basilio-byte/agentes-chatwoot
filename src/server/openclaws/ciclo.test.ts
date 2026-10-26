import { describe, expect, it } from "vitest";
import {
  ciclosRecentes,
  estaNoCiclo,
  fimDoCiclo,
  inicioDoCiclo,
  RESET_PADRAO,
} from "./ciclo";

const utc = (s: string) => new Date(`${s}Z`);

describe("inicioDoCiclo (domingo 19:00 UTC)", () => {
  it("segunda-feira 26/10/2026 pertence ao ciclo que começou em 25/10 às 19:00", () => {
    expect(inicioDoCiclo(utc("2026-10-26T11:30:00"), RESET_PADRAO).toISOString()).toBe(
      "2026-10-25T19:00:00.000Z",
    );
  });

  it("domingo 25/10 ANTES das 19:00 ainda é o ciclo da semana passada", () => {
    expect(inicioDoCiclo(utc("2026-10-25T18:59:59"), RESET_PADRAO).toISOString()).toBe(
      "2026-10-18T19:00:00.000Z",
    );
  });

  it("no instante exato do reset, o ciclo novo já começou", () => {
    expect(inicioDoCiclo(utc("2026-10-25T19:00:00"), RESET_PADRAO).toISOString()).toBe(
      "2026-10-25T19:00:00.000Z",
    );
  });

  it("sábado, no fim do ciclo", () => {
    expect(inicioDoCiclo(utc("2026-10-24T23:00:00"), RESET_PADRAO).toISOString()).toBe(
      "2026-10-18T19:00:00.000Z",
    );
  });

  it("vira o mês e o ano sem errar", () => {
    expect(inicioDoCiclo(utc("2027-01-02T10:00:00"), RESET_PADRAO).toISOString()).toBe(
      "2026-12-27T19:00:00.000Z",
    );
    expect(inicioDoCiclo(utc("2026-11-02T00:00:00"), RESET_PADRAO).toISOString()).toBe(
      "2026-11-01T19:00:00.000Z",
    );
  });

  it("respeita outro dia e hora configurados", () => {
    // Quarta (3) às 08:00 UTC. 26/10/2026 é segunda → o último reset foi quarta 21/10.
    expect(
      inicioDoCiclo(utc("2026-10-26T11:30:00"), { diaSemana: 3, horaUtc: 8 }).toISOString(),
    ).toBe("2026-10-21T08:00:00.000Z");
  });
});

describe("ciclosRecentes", () => {
  it("lista do atual para trás, de sete em sete dias", () => {
    const ciclos = ciclosRecentes(utc("2026-10-26T11:30:00"), RESET_PADRAO, 3);
    expect(ciclos.map((c) => c.inicio.toISOString())).toEqual([
      "2026-10-25T19:00:00.000Z",
      "2026-10-18T19:00:00.000Z",
      "2026-10-11T19:00:00.000Z",
    ]);
    expect(ciclos[1].fim.toISOString()).toBe(ciclos[0].inicio.toISOString());
  });
});

describe("estaNoCiclo", () => {
  const inicio = utc("2026-10-18T19:00:00");
  const ciclo = { inicio, fim: fimDoCiclo(inicio) };

  it("o início entra e o fim não", () => {
    expect(estaNoCiclo(ciclo.inicio, ciclo)).toBe(true);
    expect(estaNoCiclo(ciclo.fim, ciclo)).toBe(false);
    expect(estaNoCiclo(utc("2026-10-25T18:59:59"), ciclo)).toBe(true);
  });
});
