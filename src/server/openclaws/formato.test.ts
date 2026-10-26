import { describe, expect, it } from "vitest";
import { aoMinuto, duracaoEmHoras, haQuanto, horaDoResetEmSaoPaulo, percentual, usd } from "./formato";

describe("percentual", () => {
  it("uma casa abaixo de 10%, nenhuma acima", () => {
    expect(percentual(0.0466)).toBe("4,7%");
    expect(percentual(0.214)).toBe("21%");
    expect(percentual(1.27)).toBe("127%");
    expect(percentual(0)).toBe("0%");
  });

  it("valor inteiro não ganha casa decimal", () => {
    expect(percentual(0.04)).toBe("4%");
    expect(percentual(0.05)).toBe("5%");
    expect(percentual(0.045)).toBe("4,5%");
  });

  it("quem gastou pouco não vira 0,0%", () => {
    expect(percentual(0.0002)).toBe("<0,1%");
    expect(percentual(0.001)).toBe("0,1%");
  });

  it("sem base, é traço — e não zero", () => {
    expect(percentual(null)).toBe("—");
    expect(percentual(undefined)).toBe("—");
    expect(percentual(Number.NaN)).toBe("—");
  });
});

describe("duracaoEmHoras", () => {
  it("em horas até dois dias, depois com os dias ao lado", () => {
    expect(duracaoEmHoras(20)).toBe("20 h");
    expect(duracaoEmHoras(47)).toBe("47 h");
    expect(duracaoEmHoras(75)).toBe("75 h (3,1 dias)");
  });
});

describe("horaDoResetEmSaoPaulo", () => {
  it("19h UTC é 16h em São Paulo", () => {
    expect(horaDoResetEmSaoPaulo(19)).toBe("16:00");
    expect(horaDoResetEmSaoPaulo(3)).toBe("00:00");
  });
});

describe("aoMinuto", () => {
  it("o reset de 18:59:59 vira 19:00", () => {
    expect(aoMinuto(new Date("2026-11-01T18:59:59.617Z")).toISOString()).toBe("2026-11-01T19:00:00.000Z");
    expect(aoMinuto(new Date("2026-11-01T18:59:59Z")).toISOString()).toBe("2026-11-01T19:00:00.000Z");
  });

  it("não mexe no que já está no minuto", () => {
    expect(aoMinuto(new Date("2026-11-01T19:00:00Z")).toISOString()).toBe("2026-11-01T19:00:00.000Z");
  });
});

describe("haQuanto", () => {
  const agora = new Date("2026-10-26T12:00:00Z");
  it("diz há quanto tempo, na unidade que lê melhor", () => {
    expect(haQuanto(new Date("2026-10-26T11:59:30Z"), agora)).toBe("agora há pouco");
    expect(haQuanto(new Date("2026-10-26T11:30:00Z"), agora)).toBe("há 30 min");
    expect(haQuanto(new Date("2026-10-26T09:00:00Z"), agora)).toBe("há 3 h");
    expect(haQuanto(new Date("2026-10-23T12:00:00Z"), agora)).toBe("há 3 dias");
  });

  it("instante no futuro não vira número negativo", () => {
    expect(haQuanto(new Date("2026-10-26T13:00:00Z"), agora)).toBe("agora há pouco");
  });
});

describe("usd", () => {
  const sem = (t: string) => t.replace(/ /g, " ");

  it("duas casas, separador de milhar e vírgula", () => {
    expect(sem(usd(1047.7468))).toBe("US$ 1.047,75");
    expect(sem(usd(0.1946))).toBe("US$ 0,19");
    expect(sem(usd(0))).toBe("US$ 0,00");
  });

  it("menos de um centavo diz isso, e não US$ 0,00", () => {
    expect(sem(usd(0.004))).toBe("< US$ 0,01");
  });
});
