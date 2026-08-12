import { describe, expect, it } from "vitest";
import {
  agoraEmSaoPaulo,
  diaEmSaoPaulo,
  inicioDoDiaEmSaoPaulo,
  mensagemDeContextoTemporal,
  primeiroDiaDoMes,
  somarDias,
} from "./tempo";

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

describe("bordas do dia em São Paulo", () => {
  it("começa o dia às 03:00 UTC", () => {
    expect(inicioDoDiaEmSaoPaulo("2026-08-11").toISOString()).toBe(
      "2026-08-11T03:00:00.000Z",
    );
  });

  it("fecha o dia certo nas três horas finais", () => {
    // 23:59 de 11/08 em SP ainda é 11/08 — em UTC já virou 12/08. É este o
    // erro que jogaria três horas de faturamento para o dia seguinte.
    const fimDoDia = new Date("2026-08-12T02:59:00Z");
    expect(diaEmSaoPaulo(fimDoDia)).toBe("2026-08-11");

    const inicioDoSeguinte = inicioDoDiaEmSaoPaulo("2026-08-12");
    expect(fimDoDia.getTime()).toBeLessThan(inicioDoSeguinte.getTime());
  });

  it("é consistente com diaEmSaoPaulo em toda volta do ano", () => {
    for (let mes = 1; mes <= 12; mes++) {
      const dia = `2026-${String(mes).padStart(2, "0")}-15`;
      expect(diaEmSaoPaulo(inicioDoDiaEmSaoPaulo(dia))).toBe(dia);
      // Um milissegundo antes ainda é o dia anterior.
      const antes = new Date(inicioDoDiaEmSaoPaulo(dia).getTime() - 1);
      expect(diaEmSaoPaulo(antes)).not.toBe(dia);
    }
  });

  it("soma dias atravessando mês e ano", () => {
    expect(somarDias("2026-08-11", 1)).toBe("2026-08-12");
    expect(somarDias("2026-08-31", 1)).toBe("2026-09-01");
    expect(somarDias("2026-01-01", -1)).toBe("2025-12-31");
    expect(somarDias("2026-08-11", -30)).toBe("2026-07-12");
  });

  it("acha o primeiro dia do mês", () => {
    expect(primeiroDiaDoMes("2026-08-11")).toBe("2026-08-01");
    expect(primeiroDiaDoMes("2026-01-31")).toBe("2026-01-01");
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
