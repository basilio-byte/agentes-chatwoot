import { describe, expect, it } from "vitest";
import { agoraEmSaoPaulo, mensagemDeContextoTemporal } from "./tempo";

describe("hora de São Paulo", () => {
  it("converte de UTC para o fuso de São Paulo", () => {
    // 2026-07-28 02:30 UTC = 2026-07-27 23:30 em São Paulo (UTC-3).
    // O dia vira o anterior — é justamente o erro que o servidor em UTC cometeria.
    const r = agoraEmSaoPaulo(new Date("2026-07-28T02:30:00Z"));

    expect(r.iso).toBe("2026-07-27");
    expect(r.data).toBe("27/07/2026");
    expect(r.hora).toBe("23:30");
    expect(r.diaDaSemana).toBe("segunda-feira");
  });

  it("usa relógio de 24 horas", () => {
    const r = agoraEmSaoPaulo(new Date("2026-07-28T20:05:00Z")); // 17:05 em SP
    expect(r.hora).toBe("17:05");
  });

  it("acerta o dia da semana ao longo da semana", () => {
    const dias = [
      ["2026-07-26T15:00:00Z", "domingo"],
      ["2026-07-27T15:00:00Z", "segunda-feira"],
      ["2026-07-28T15:00:00Z", "terça-feira"],
      ["2026-08-01T15:00:00Z", "sábado"],
    ] as const;

    for (const [iso, esperado] of dias) {
      expect(agoraEmSaoPaulo(new Date(iso)).diaDaSemana).toBe(esperado);
    }
  });

  it("atravessa a virada do ano sem se perder", () => {
    const r = agoraEmSaoPaulo(new Date("2027-01-01T01:00:00Z")); // 31/12 22:00 em SP
    expect(r.iso).toBe("2026-12-31");
  });
});

describe("mensagem de contexto temporal", () => {
  it("diz o dia, a data, a hora e o fuso", () => {
    const m = mensagemDeContextoTemporal(new Date("2026-07-28T15:00:00Z"));

    expect(m).toContain("terça-feira");
    expect(m).toContain("28/07/2026");
    expect(m).toContain("12:00");
    expect(m).toContain("São Paulo");
  });

  it("orienta o uso para datas relativas", () => {
    const m = mensagemDeContextoTemporal();
    expect(m).toContain("amanhã");
  });
});
