import { describe, expect, it } from "vitest";
import {
  agregar,
  compactar,
  condensarSerie,
  SEM_MODELO,
  type LinhaDeConsumo,
} from "./agregacao";

function linha(over: Partial<LinhaDeConsumo> = {}): LinhaDeConsumo {
  return {
    createdAt: new Date("2026-08-11T15:00:00Z"),
    model: "openai/gpt-5.6-luna",
    agentId: "agente-1",
    source: "CHATWOOT",
    status: "SUCCESS",
    costUsd: 0.01,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 800,
    latencyMs: 2000,
    conversationId: "conversa-1",
    ...over,
  };
}

describe("totais", () => {
  it("soma custo, tokens e execuções", () => {
    const a = agregar([
      linha({ costUsd: 0.02, inputTokens: 100, outputTokens: 10 }),
      linha({ costUsd: 0.03, inputTokens: 200, outputTokens: 20 }),
    ]);

    expect(a.totais.custoUsd).toBeCloseTo(0.05, 10);
    expect(a.totais.execucoes).toBe(2);
    expect(a.totais.tokensEntrada).toBe(300);
    expect(a.totais.tokensSaida).toBe(30);
    expect(a.totais.tokens).toBe(330);
  });

  it("conta conversa distinta, não execução", () => {
    // Três turnos da mesma conversa custam três vezes, mas são um atendimento
    // só — é o custo por atendimento que responde "quanto custa atender".
    const a = agregar([
      linha({ conversationId: "c1", costUsd: 0.01 }),
      linha({ conversationId: "c1", costUsd: 0.01 }),
      linha({ conversationId: "c2", costUsd: 0.02 }),
    ]);

    expect(a.totais.conversas).toBe(2);
    expect(a.totais.custoPorConversa).toBeCloseTo(0.02, 10);
  });

  it("execução sem conversa não vira conversa", () => {
    const a = agregar([
      linha({ conversationId: null, source: "TRIGGER" }),
      linha({ conversationId: null, source: "PLAYGROUND" }),
    ]);

    expect(a.totais.conversas).toBe(0);
    expect(a.totais.custoPorConversa).toBeNull();
  });

  it("conta erros sem tirá-los do custo", () => {
    // Turno que falhou depois de queimar tokens foi cobrado pela OpenRouter.
    // Ignorá-lo na apuração esconderia justamente o gasto que não deu resultado.
    const a = agregar([
      linha({ status: "ERROR", costUsd: 0.04 }),
      linha({ status: "SUCCESS", costUsd: 0.01 }),
    ]);

    expect(a.totais.erros).toBe(1);
    expect(a.totais.custoUsd).toBeCloseTo(0.05, 10);
  });

  it("média de latência ignora quem não registrou", () => {
    const a = agregar([
      linha({ latencyMs: 1000 }),
      linha({ latencyMs: 3000 }),
      linha({ latencyMs: null }),
    ]);

    expect(a.totais.latenciaMediaMs).toBe(2000);
  });

  it("período vazio não divide por zero", () => {
    const a = agregar([]);

    expect(a.totais.custoUsd).toBe(0);
    expect(a.totais.custoMedioPorExecucao).toBe(0);
    expect(a.totais.custoPorConversa).toBeNull();
    expect(a.totais.latenciaMediaMs).toBeNull();
  });
});

describe("quebras", () => {
  it("separa por modelo e calcula a parcela do custo", () => {
    const a = agregar([
      linha({ model: "a/caro", costUsd: 0.75 }),
      linha({ model: "b/barato", costUsd: 0.25 }),
    ]);

    expect(a.porModelo.map((f) => f.chave)).toEqual(["a/caro", "b/barato"]);
    expect(a.porModelo[0].parcela).toBeCloseTo(0.75, 10);
    expect(a.porModelo[1].parcela).toBeCloseTo(0.25, 10);
  });

  it("ordena do maior custo para o menor", () => {
    const a = agregar([
      linha({ agentId: "pequeno", costUsd: 0.01 }),
      linha({ agentId: "grande", costUsd: 0.5 }),
      linha({ agentId: "medio", costUsd: 0.1 }),
    ]);

    expect(a.porAgente.map((f) => f.chave)).toEqual([
      "grande",
      "medio",
      "pequeno",
    ]);
  });

  it("desempata por execuções e depois pela chave, para a ordem não dançar", () => {
    // Modelo grátis zera o custo de todo mundo; sem desempate estável a tabela
    // trocava de ordem a cada recarga.
    const a = agregar([
      linha({ model: "z/gratis", costUsd: 0 }),
      linha({ model: "a/gratis", costUsd: 0 }),
      linha({ model: "a/gratis", costUsd: 0 }),
    ]);

    expect(a.porModelo.map((f) => f.chave)).toEqual(["a/gratis", "z/gratis"]);
  });

  it("execução sem modelo registrado vira uma fatia própria", () => {
    // Nunca atribuída ao modelo atual do agente: seria reescrever o passado.
    const a = agregar([linha({ model: null }), linha({ model: "x/y" })]);

    expect(a.porModelo.map((f) => f.chave).sort()).toEqual(
      [SEM_MODELO, "x/y"].sort(),
    );
  });

  it("separa produção de teste pela fonte", () => {
    const a = agregar([
      linha({ source: "CHATWOOT", costUsd: 0.1 }),
      linha({ source: "PLAYGROUND", costUsd: 0.02 }),
      linha({ source: "TRIGGER", costUsd: 0.03 }),
    ]);

    expect(a.porFonte).toHaveLength(3);
    expect(a.porFonte[0].chave).toBe("CHATWOOT");
  });

  it("parcela é zero quando ninguém gastou, sem NaN", () => {
    const a = agregar([linha({ costUsd: 0 })]);
    expect(a.porModelo[0].parcela).toBe(0);
  });
});

describe("série diária", () => {
  it("agrupa pelo dia civil de São Paulo", () => {
    // 02:00 UTC do dia 12 ainda é dia 11 em São Paulo. Agrupar por UTC jogaria
    // esta execução para o dia seguinte.
    const a = agregar(
      [
        linha({ createdAt: new Date("2026-08-11T15:00:00Z"), costUsd: 0.01 }),
        linha({ createdAt: new Date("2026-08-12T02:00:00Z"), costUsd: 0.02 }),
      ],
      ["2026-08-11", "2026-08-12"],
    );

    expect(a.porDia).toEqual([
      { dia: "2026-08-11", custoUsd: 0.03, execucoes: 2, tokens: 2200 },
      { dia: "2026-08-12", custoUsd: 0, execucoes: 0, tokens: 0 },
    ]);
  });

  it("mantém no gráfico o dia sem gasto nenhum", () => {
    const a = agregar(
      [linha({ createdAt: new Date("2026-08-11T15:00:00Z") })],
      ["2026-08-09", "2026-08-10", "2026-08-11"],
    );

    expect(a.porDia.map((p) => p.dia)).toEqual([
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
    ]);
    expect(a.porDia[0].execucoes).toBe(0);
  });

  it("dia com dado fora da lista pedida ainda aparece, em ordem", () => {
    const a = agregar(
      [linha({ createdAt: new Date("2026-08-01T15:00:00Z") })],
      ["2026-08-11"],
    );

    expect(a.porDia.map((p) => p.dia)).toEqual(["2026-08-01", "2026-08-11"]);
  });
});

describe("condensar série", () => {
  const serie = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      dia: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      custoUsd: 1,
      execucoes: 2,
      tokens: 10,
    }));

  it("não mexe em série que já cabe", () => {
    const r = condensarSerie(serie(30));
    expect(r.diasPorColuna).toBe(1);
    expect(r.pontos).toHaveLength(30);
  });

  it("agrupa quando passa do teto e preserva o total", () => {
    const r = condensarSerie(serie(365));

    expect(r.diasPorColuna).toBeGreaterThan(1);
    expect(r.pontos.length).toBeLessThanOrEqual(92);
    // A soma tem de sobreviver ao agrupamento — é dinheiro.
    expect(r.pontos.reduce((s, p) => s + p.custoUsd, 0)).toBe(365);
    expect(r.pontos.reduce((s, p) => s + p.execucoes, 0)).toBe(730);
  });

  it("rotula o bloco pelo primeiro dia dele", () => {
    const r = condensarSerie(serie(200));
    expect(r.pontos[0].dia).toBe("2026-01-01");
  });
});

describe("compactar", () => {
  it("encurta milhares e milhões", () => {
    expect(compactar(950)).toBe("950");
    expect(compactar(12_345)).toBe("12,3 mil");
    expect(compactar(2_500_000)).toBe("2,5 mi");
  });
});
