import { describe, expect, it } from "vitest";
import type { LinhaDeLimite, LinhaDeUso } from "./agregacao";
import { RESET_PADRAO } from "./ciclo";
import type { ConteinerConfigurado } from "./config";
import type { LeituraDeCota } from "./cota-real";
import { montarPanorama, type EntradaDoPanorama } from "./panorama";

const utc = (s: string) => new Date(`${s}Z`);
const HORA = 3_600_000;

/** Uma linha de uso que custa exatamente `usd` no Sonnet 5 (US$ 2 por milhão de entrada). */
function gasto(hora: Date, conteiner: string, usd: number): LinhaDeUso {
  return {
    hora,
    conteiner,
    agente: "main",
    tipo: "main",
    modelo: "claude-sonnet-5",
    chamadas: 2,
    entrada: Math.round(usd * 500_000),
    saida: 0,
    cacheLeitura: 0,
    cacheEscrita: 0,
  };
}

function porHora(de: string, ate: string, conteiner: string, usd: number): LinhaDeUso[] {
  const linhas: LinhaDeUso[] = [];
  for (let t = utc(de).getTime(); t < utc(ate).getTime(); t += HORA) {
    linhas.push(gasto(new Date(t), conteiner, usd));
  }
  return linhas;
}

function leitura(
  lidaEm: string,
  janela: string,
  utilizacao: number,
  resetaEm: string | null = null,
): LeituraDeCota {
  return { lidaEm: utc(lidaEm), janela, utilizacao, resetaEm: resetaEm ? utc(resetaEm) : null, plano: "max" };
}

const conteineres: ConteinerConfigurado[] = [
  { id: "lr9a", nome: "Diego", compartilhada: true },
  { id: "xqxb", nome: "Nathã", compartilhada: true },
  { id: "2bpu", nome: "Guilherme", compartilhada: false },
];

/** O ciclo atual, de 25/10 19h a 26/10 10h: lr9a US$ 2/h + xqxb US$ 1/h × 16 h = US$ 48. */
const linhas: LinhaDeUso[] = [
  ...porHora("2026-10-25T19:00", "2026-10-26T11:00", "lr9a", 2),
  ...porHora("2026-10-25T19:00", "2026-10-26T11:00", "xqxb", 1),
  ...porHora("2026-10-25T19:00", "2026-10-26T11:00", "2bpu", 0.5),
];

function panorama(parcial: Partial<EntradaDoPanorama> = {}) {
  return montarPanorama({
    agora: utc("2026-10-26T11:30"),
    linhas,
    limites: [] as LinhaDeLimite[],
    conteineres,
    reset: RESET_PADRAO,
    cotaManualUsd: null,
    periodo: { inicio: null, fim: null },
    dias: [],
    leituras: [],
    ...parcial,
  });
}

const RESET_CERTO = "2026-11-01T18:59:59.617"; // a Anthropic informa com décimos antes da hora

const leiturasDeAgora = [
  leitura("2026-10-26T11:07", "seven_day", 5, RESET_CERTO),
  leitura("2026-10-26T11:07", "five_hour", 3, "2026-10-26T15:59:59.617"),
  leitura("2026-10-26T11:07", "seven_day_opus", 0, RESET_CERTO),
];

describe("com a leitura real da Anthropic", () => {
  it("a % da semana é a medida, e o painel diz que é medida", () => {
    const p = panorama({ leituras: leiturasDeAgora });
    expect(p.doCiclo.medida).toBe(true);
    expect(p.doCiclo.fracaoDaCota).toBeCloseTo(0.05, 6);
    expect(p.real?.semanal?.utilizacao).toBe(5);
    expect(p.real?.cincoHoras?.utilizacao).toBe(3);
    expect(p.real?.atrasada).toBe(false);
  });

  it("a cota em US$ é calibrada pela leitura: US$ 48 em 5% → US$ 960", () => {
    const p = panorama({ leituras: leiturasDeAgora });
    expect(p.cota.origem).toBe("medida");
    expect(p.cota.usd).toBeCloseTo(960, 4);
    expect(p.cota.amostras).toBe(1);
  });

  it("a % medida é repartida pelo consumo: a soma das pessoas dá a % da conta", () => {
    const p = panorama({ leituras: leiturasDeAgora });
    const diego = p.pessoas.find((x) => x.conteiner === "lr9a")!;
    const natha = p.pessoas.find((x) => x.conteiner === "xqxb")!;
    expect(diego.fracaoDaCota).toBeCloseTo(0.05 * (32 / 48), 6);
    expect(natha.fracaoDaCota).toBeCloseTo(0.05 * (16 / 48), 6);
    expect((diego.fracaoDaCota ?? 0) + (natha.fracaoDaCota ?? 0)).toBeCloseTo(0.05, 6);
  });

  it("o Guilherme segue fora da cota, mesmo com leitura", () => {
    const g = panorama({ leituras: leiturasDeAgora }).pessoas.find((x) => x.conteiner === "2bpu")!;
    expect(g.fracaoDaCota).toBeNull();
    expect(g.ciclo.usd).toBeGreaterThan(0);
  });

  it("a cota informada à mão continua mandando no valor em US$, e a % segue a medida", () => {
    const p = panorama({ leituras: leiturasDeAgora, cotaManualUsd: 500 });
    expect(p.cota).toMatchObject({ origem: "manual", usd: 500 });
    expect(p.doCiclo.fracaoDaCota).toBeCloseTo(0.05, 6);
  });

  it("o reset informado (18:59:59,6) bate com o configurado (19:00)", () => {
    expect(panorama({ leituras: leiturasDeAgora }).divergeDoReset).toBe(false);
  });

  it("reset de outro horário avisa que a conta lida pode ser outra", () => {
    const leituras = [leitura("2026-10-26T11:07", "seven_day", 5, "2026-11-01T10:59:59.617")];
    expect(panorama({ leituras }).divergeDoReset).toBe(true);
  });

  it("nenhuma janela informa reset: não há divergência a acusar", () => {
    expect(panorama({ leituras: [leitura("2026-10-26T11:07", "seven_day", 5)] }).divergeDoReset).toBe(false);
  });

  it("o histórico marca a semana medida e a estimada", () => {
    const p = panorama({ leituras: leiturasDeAgora });
    expect(p.historico[0].medida).toBe(true);
    expect(p.historico[0].fracaoDaCota).toBeCloseTo(0.05, 6);
    expect(p.historico[1].medida).toBe(false);
  });

  it("a semana passada mostra a % que a Anthropic mediu no fim dela", () => {
    const leituras = [
      ...leiturasDeAgora,
      leitura("2026-10-22T14:07", "seven_day", 100, "2026-10-25T19:00"),
      leitura("2026-10-24T10:07", "seven_day", 100, "2026-10-25T19:00"),
    ];
    const p = panorama({ leituras });
    expect(p.historico[1].medida).toBe(true);
    expect(p.historico[1].fracaoDaCota).toBe(1);
  });
});

describe("leitura real que não vale", () => {
  it("atrasada (mais de 6 h): aparece, mas os números voltam à estimativa", () => {
    const leituras = [leitura("2026-10-26T01:07", "seven_day", 5, RESET_CERTO)];
    const p = panorama({ leituras });
    expect(p.real?.atrasada).toBe(true);
    expect(p.doCiclo.medida).toBe(false);
  });

  it("sem leitura nenhuma, tudo como antes: nada de real", () => {
    const p = panorama({ leituras: [] });
    expect(p.real).toBeNull();
    expect(p.doCiclo.medida).toBe(false);
    expect(p.divergeDoReset).toBe(false);
    expect(p.cota.origem).toBe("nenhuma");
  });

  it("leitura baixa demais (2%) vale como % mas não calibra a cota em US$", () => {
    const p = panorama({ leituras: [leitura("2026-10-26T11:07", "seven_day", 2, RESET_CERTO)] });
    expect(p.doCiclo.fracaoDaCota).toBeCloseTo(0.02, 6);
    expect(p.cota.origem).toBe("nenhuma");
  });
});

describe("bloqueio e previsão pela leitura real", () => {
  it("janela de 5 horas a 100% é bloqueio, mesmo sem nenhum 429 recebido", () => {
    const leituras = [
      leitura("2026-10-26T11:07", "seven_day", 30, RESET_CERTO),
      leitura("2026-10-26T11:07", "five_hour", 100, "2026-10-26T15:59:59"),
    ];
    expect(panorama({ leituras }).bloqueadoAgora).toBe(true);
  });

  it("sem janela cheia nem 429, não está bloqueada", () => {
    expect(panorama({ leituras: leiturasDeAgora }).bloqueadoAgora).toBe(false);
  });

  it("a previsão sai do ritmo da % medida: 60% em 16,5 h, os 40% restantes em 11 h", () => {
    const leituras = [leitura("2026-10-26T11:07", "seven_day", 60, RESET_CERTO)];
    const p = panorama({ leituras });
    expect(p.projecao?.base).toBe("medida");
    // (1 - 0,6) / 0,6 × 16,5 h = 11 h depois das 11:30.
    expect(p.projecao?.acabaEm?.toISOString().slice(0, 16)).toBe("2026-10-26T22:30");
  });

  it("no ritmo medido a cota dura até o reset: não prevê esgotamento", () => {
    const p = panorama({ leituras: leiturasDeAgora });
    expect(p.projecao?.base).toBe("medida");
    expect(p.projecao?.acabaEm).toBeNull();
  });
});
