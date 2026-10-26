import { describe, expect, it } from "vitest";
import type { LinhaDeLimite, LinhaDeUso } from "./agregacao";
import { RESET_PADRAO } from "./ciclo";
import type { ConteinerConfigurado } from "./config";
import { montarPanorama, type EntradaDoPanorama } from "./panorama";

const utc = (s: string) => new Date(`${s}Z`);
const HORA = 3_600_000;

/** Uma linha de uso que custa exatamente `usd` no Sonnet 5 (US$ 2 por milhão de entrada). */
function gasto(hora: Date, conteiner: string, usd: number, agente = "main"): LinhaDeUso {
  return {
    hora,
    conteiner,
    agente,
    tipo: "main",
    modelo: "claude-sonnet-5",
    chamadas: 2,
    entrada: Math.round(usd * 500_000),
    saida: 0,
    cacheLeitura: 0,
    cacheEscrita: 0,
  };
}

/** Uma linha por hora cheia, de `de` (inclusive) a `ate` (EXCLUSIVE). */
function porHora(
  de: string,
  ate: string,
  conteiner: string,
  usd: number,
  agente = "main",
): LinhaDeUso[] {
  const linhas: LinhaDeUso[] = [];
  for (let t = utc(de).getTime(); t < utc(ate).getTime(); t += HORA) {
    linhas.push(gasto(new Date(t), conteiner, usd, agente));
  }
  return linhas;
}

function recusas(conteiner: string, de: string, ate: string, por = 4): LinhaDeLimite[] {
  const linhas: LinhaDeLimite[] = [];
  for (let t = utc(de).getTime(); t <= utc(ate).getTime(); t += HORA) {
    linhas.push({ hora: new Date(t), conteiner, categoria: "rate_limit", quantidade: por });
  }
  return linhas;
}

const conteineres: ConteinerConfigurado[] = [
  { id: "lr9a", nome: "Diego", compartilhada: true },
  { id: "xqxb", nome: "Nathã", compartilhada: true },
  { id: "2bpu", nome: "Guilherme", compartilhada: false },
];

/**
 * Um mês parecido com o de outubro de 2026: três bloqueios (o último, de um ciclo
 * com dados incompletos), a conta do Guilherme trabalhando o tempo todo, e o
 * ciclo atual no começo.
 */
function historia() {
  const linhas: LinhaDeUso[] = [
    // Ciclo 04/10 19h → 11/10 19h: US$ 8/h até o bloqueio de 09/10 23h (125 h = US$ 1.000).
    ...porHora("2026-10-04T19:00", "2026-10-10T00:00", "lr9a", 5),
    ...porHora("2026-10-04T19:00", "2026-10-10T00:00", "xqxb", 3),
    // Ciclo 11/10 19h → 18/10 19h: US$ 7/h até o bloqueio de 17/10 23h (149 h = US$ 1.043).
    ...porHora("2026-10-11T19:00", "2026-10-18T00:00", "lr9a", 5),
    ...porHora("2026-10-11T19:00", "2026-10-18T00:00", "xqxb", 2),
    // Ciclo 18/10 19h → 25/10 19h: só 21 h de dados (coletor incompleto) = US$ 210.
    ...porHora("2026-10-18T19:00", "2026-10-19T16:00", "lr9a", 6),
    ...porHora("2026-10-18T19:00", "2026-10-19T16:00", "xqxb", 4),
    // Ciclo atual, desde 25/10 19h até 26/10 10h: US$ 3/h (lr9a 2 + xqxb 1) × 16 h = US$ 48.
    ...porHora("2026-10-25T19:00", "2026-10-26T11:00", "lr9a", 2),
    ...porHora("2026-10-25T19:00", "2026-10-26T11:00", "xqxb", 1),
    // O OpenClaw do Guilherme não parou em nenhum bloqueio.
    ...porHora("2026-10-04T19:00", "2026-10-26T11:00", "2bpu", 0.5),
  ];
  const limites: LinhaDeLimite[] = [
    ...recusas("lr9a", "2026-10-09T23:00", "2026-10-11T18:00"),
    ...recusas("lr9a", "2026-10-17T23:00", "2026-10-18T18:00"),
    ...recusas("lr9a", "2026-10-19T16:00", "2026-10-25T18:00"),
    // Uma recusa solta do Guilherme: não é bloqueio de ninguém.
    { hora: utc("2026-10-10T18:00"), conteiner: "2bpu", categoria: "rate_limit", quantidade: 1 },
  ];
  return { linhas, limites };
}

function panorama(parcial: Partial<EntradaDoPanorama> = {}) {
  const { linhas, limites } = historia();
  return montarPanorama({
    agora: utc("2026-10-26T11:30"),
    linhas,
    limites,
    conteineres,
    reset: RESET_PADRAO,
    cotaManualUsd: null,
    periodo: { inicio: null, fim: null },
    dias: [],
    ...parcial,
  });
}

describe("a cota, medida pelos bloqueios", () => {
  it("é a média dos ciclos que travaram, sem o ciclo de dados incompletos", () => {
    const p = panorama();
    expect(p.cota.origem).toBe("estimada");
    expect(p.cota.amostras).toBe(2);
    expect(p.cota.usd).toBeCloseTo((1000 + 1043) / 2, 1);
    expect(p.cota.minimo).toBeCloseTo(1000, 1);
    expect(p.cota.maximo).toBeCloseTo(1043, 1);
  });

  it("sem nenhum bloqueio, não inventa cota", () => {
    const { linhas } = historia();
    const p = montarPanorama({
      agora: utc("2026-10-26T11:30"),
      linhas,
      limites: [],
      conteineres,
      reset: RESET_PADRAO,
      cotaManualUsd: null,
      periodo: { inicio: null, fim: null },
      dias: [],
    });
    expect(p.cota).toMatchObject({ usd: null, origem: "nenhuma", amostras: 0 });
    expect(p.doCiclo.fracaoDaCota).toBeNull();
    expect(p.pessoas.every((x) => x.fracaoDaCota === null)).toBe(true);
  });

  it("a cota informada à mão vence a estimada", () => {
    const p = panorama({ cotaManualUsd: 480 });
    expect(p.cota).toMatchObject({ usd: 480, origem: "manual" });
    expect(p.doCiclo.fracaoDaCota).toBeCloseTo(48 / 480, 6);
  });
});

describe("o ciclo atual", () => {
  it("começa no último domingo às 19h UTC e termina uma semana depois", () => {
    const p = panorama();
    expect(p.cicloAtual.inicio.toISOString()).toBe("2026-10-25T19:00:00.000Z");
    expect(p.proximoReset.toISOString()).toBe("2026-11-01T19:00:00.000Z");
  });

  it("soma só a conta compartilhada: o Guilherme fica de fora da cota", () => {
    const p = panorama();
    expect(p.doCiclo.totais.usd).toBeCloseTo(48, 4);
    expect(p.doCiclo.fracaoDaCota).toBeCloseTo(48 / 1021.5, 3);
  });

  it("cada pessoa tem a sua fatia da cota e do ciclo", () => {
    const p = panorama();
    const diego = p.pessoas.find((x) => x.conteiner === "lr9a")!;
    const natha = p.pessoas.find((x) => x.conteiner === "xqxb")!;
    expect(diego.ciclo.usd).toBeCloseTo(32, 4);
    expect(natha.ciclo.usd).toBeCloseTo(16, 4);
    expect(diego.parteDoCiclo).toBeCloseTo(32 / 48, 4);
    expect(natha.parteDoCiclo).toBeCloseTo(16 / 48, 4);
    expect(diego.fracaoDaCota).toBeCloseTo(32 / 1021.5, 3);
  });

  it("o Guilherme aparece com o consumo dele, marcado como conta própria", () => {
    const p = panorama();
    const g = p.pessoas.find((x) => x.conteiner === "2bpu")!;
    expect(g.nome).toBe("Guilherme");
    expect(g.compartilhada).toBe(false);
    expect(g.ciclo.usd).toBeCloseTo(0.5 * 16, 4);
    expect(g.fracaoDaCota).toBeNull();
    expect(g.parteDoCiclo).toBeNull();
  });

  it("a conta compartilhada vem primeiro, do maior gasto ao menor; a própria por último", () => {
    expect(panorama().pessoas.map((x) => x.conteiner)).toEqual(["lr9a", "xqxb", "2bpu"]);
  });

  it("detalha por agente dentro de cada OpenClaw", () => {
    const linhas = [
      ...porHora("2026-10-25T19:00", "2026-10-26T01:00", "lr9a", 4, "main"),
      ...porHora("2026-10-25T19:00", "2026-10-26T01:00", "lr9a", 1, "doca"),
    ];
    const p = panorama({ linhas, limites: [] });
    const diego = p.pessoas.find((x) => x.conteiner === "lr9a")!;
    expect(diego.agentes.map((a) => a.agente)).toEqual(["main", "doca"]);
    expect(diego.agentes[0].ciclo.usd).toBeCloseTo(24, 4);
  });

  it("OpenClaw que o coletor encontrou e ninguém nomeou aparece com o id", () => {
    const p = panorama({ conteineres: [] });
    expect(p.pessoas.find((x) => x.conteiner === "lr9a")?.nome).toBe("OpenClaw lr9a");
  });
});

describe("o ritmo da semana", () => {
  it("no ritmo atual a cota sobra até o reset: não há previsão de acabar", () => {
    const p = panorama();
    expect(p.projecao?.usdPorHora).toBeCloseTo(48 / 16.5, 3);
    expect(p.projecao?.acabaEm).toBeNull();
  });

  it("com uma cota menor, prevê quando acaba", () => {
    const p = panorama({ cotaManualUsd: 100 });
    // Faltam US$ 52 a US$ 2,909/h = ~17,9 h depois das 11:30.
    expect(p.projecao?.acabaEm?.toISOString().slice(0, 13)).toBe("2026-10-27T05");
  });

  it("nas primeiras horas do ciclo não projeta: o ritmo ainda é ruído", () => {
    const p = panorama({ agora: utc("2026-10-25T22:00") });
    expect(p.projecao).toBeNull();
  });
});

describe("bloqueios", () => {
  it("acha os três, e ignora a recusa solta do Guilherme", () => {
    const p = panorama();
    expect(p.bloqueios).toHaveLength(3);
    expect(p.bloqueadoAgora).toBe(false);
  });

  it("o histórico diz quantas horas cada ciclo ficou parado", () => {
    const p = panorama();
    // Ciclo 18/10 19h → 25/10 19h: bloqueio de 19/10 16h a 25/10 19h = 147 h.
    const ciclo = p.historico.find((c) => c.inicio.toISOString() === "2026-10-18T19:00:00.000Z")!;
    expect(ciclo.horasBloqueadas).toBe(147);
    expect(p.historico[0].atual).toBe(true);
    expect(p.historico[0].horasBloqueadas).toBe(0);
    expect(p.historico).toHaveLength(8);
  });

  it("o histórico traz o gasto de cada pessoa no ciclo, a conta própria incluída", () => {
    const p = panorama();
    const atual = p.historico[0];
    expect(atual.totais.usd).toBeCloseTo(48, 4);
    expect(atual.porPessoa.map((x) => x.conteiner)).toEqual(["lr9a", "xqxb", "2bpu"]);
  });
});

describe("o período do filtro", () => {
  it("recorta pessoas e série sem mexer na cota nem no ciclo", () => {
    const p = panorama({
      periodo: { inicio: utc("2026-10-26T00:00"), fim: null },
      dias: ["2026-10-25", "2026-10-26"],
    });
    const diego = p.pessoas.find((x) => x.conteiner === "lr9a")!;
    // 26/10 00h a 10h = 11 horas × US$ 2.
    expect(diego.periodo.usd).toBeCloseTo(22, 4);
    expect(diego.ciclo.usd).toBeCloseTo(32, 4);
    expect(p.cota.usd).toBeCloseTo(1021.5, 1);
  });

  it("a série diária tem um ponto por dia pedido", () => {
    const p = panorama({
      periodo: { inicio: utc("2026-10-25T00:00"), fim: null },
      dias: ["2026-10-25", "2026-10-26"],
    });
    expect(p.serieDiaria.map((d) => d.dia)).toEqual(["2026-10-25", "2026-10-26"]);
    expect(p.serieDiaria.reduce((s, d) => s + d.custoUsd, 0)).toBeGreaterThan(0);
  });

  it("quebra por modelo e por tipo de sessão", () => {
    const p = panorama({ periodo: { inicio: utc("2026-10-25T00:00"), fim: null } });
    expect(p.porModelo[0].modelo).toBe("claude-sonnet-5");
    expect(p.porTipo[0].tipo).toBe("main");
  });

  it("conta as chamadas que ficaram fora do custo", () => {
    const linhas = [
      gasto(utc("2026-10-26T01:00"), "lr9a", 1),
      { ...gasto(utc("2026-10-26T02:00"), "lr9a", 0), modelo: "deepseek/deepseek-v4-flash", chamadas: 14, entrada: 100_000 },
      { ...gasto(utc("2026-10-26T03:00"), "lr9a", 0), modelo: "claude-sonnet-9", chamadas: 3, entrada: 100_000 },
    ];
    const p = panorama({ linhas, limites: [] });
    expect(p.foraDoCusto).toEqual({ semTarifa: 3, foraDaConta: 14 });
  });
});
