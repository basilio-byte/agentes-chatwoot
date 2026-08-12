import { describe, expect, it } from "vitest";
import {
  diasDoIntervalo,
  ehDiaValido,
  intervaloDoPeriodo,
  normalizarPeriodo,
  PERIODO_PADRAO,
} from "./periodo";

// 11/08/2026, 19:52 em São Paulo (22:52 UTC). Perto do fim do dia de propósito:
// é onde o corte por UTC erraria o dia.
const AGORA = new Date("2026-08-11T22:52:00Z");

describe("intervalo do período", () => {
  it("hoje começa às 03:00 UTC e termina no começo de amanhã", () => {
    const i = intervaloDoPeriodo("hoje", {}, AGORA);

    expect(i.primeiroDia).toBe("2026-08-11");
    expect(i.ultimoDia).toBe("2026-08-11");
    expect(i.inicio?.toISOString()).toBe("2026-08-11T03:00:00.000Z");
    expect(i.fim?.toISOString()).toBe("2026-08-12T03:00:00.000Z");
  });

  it("não deixa a virada de dia em UTC contaminar o hoje", () => {
    // 21:30 em SP no dia 11 já é 00:30 do dia 12 em UTC. Um corte por UTC
    // devolveria o dia 12.
    const tardeDaNoite = new Date("2026-08-12T00:30:00Z");
    expect(intervaloDoPeriodo("hoje", {}, tardeDaNoite).primeiroDia).toBe(
      "2026-08-11",
    );
  });

  it("7 dias inclui hoje", () => {
    const i = intervaloDoPeriodo("7d", {}, AGORA);
    expect(i.primeiroDia).toBe("2026-08-05");
    expect(i.ultimoDia).toBe("2026-08-11");
    expect(diasDoIntervalo(i)).toHaveLength(7);
  });

  it("30 dias inclui hoje", () => {
    const i = intervaloDoPeriodo("30d", {}, AGORA);
    expect(i.primeiroDia).toBe("2026-07-13");
    expect(diasDoIntervalo(i)).toHaveLength(30);
  });

  it("este mês vai do dia 1 até hoje", () => {
    const i = intervaloDoPeriodo("mes", {}, AGORA);
    expect(i.primeiroDia).toBe("2026-08-01");
    expect(i.ultimoDia).toBe("2026-08-11");
  });

  it("mês passado fecha no último dia dele", () => {
    const i = intervaloDoPeriodo("mes-passado", {}, AGORA);
    expect(i.primeiroDia).toBe("2026-07-01");
    expect(i.ultimoDia).toBe("2026-07-31");
    expect(i.fim?.toISOString()).toBe("2026-08-01T03:00:00.000Z");
  });

  it("ontem é um dia só", () => {
    const i = intervaloDoPeriodo("ontem", {}, AGORA);
    expect(i.primeiroDia).toBe("2026-08-10");
    expect(i.ultimoDia).toBe("2026-08-10");
  });

  it("tudo não tem borda de início", () => {
    const i = intervaloDoPeriodo("tudo", {}, AGORA);
    expect(i.inicio).toBeNull();
    expect(i.fim).toBeNull();
  });
});

describe("período personalizado", () => {
  it("usa as duas datas informadas", () => {
    const i = intervaloDoPeriodo(
      "custom",
      { de: "2026-07-01", ate: "2026-07-15" },
      AGORA,
    );
    expect(i.primeiroDia).toBe("2026-07-01");
    expect(i.ultimoDia).toBe("2026-07-15");
    expect(i.fim?.toISOString()).toBe("2026-07-16T03:00:00.000Z");
  });

  it("troca as pontas quando vêm invertidas", () => {
    const i = intervaloDoPeriodo(
      "custom",
      { de: "2026-07-15", ate: "2026-07-01" },
      AGORA,
    );
    expect(i.primeiroDia).toBe("2026-07-01");
    expect(i.ultimoDia).toBe("2026-07-15");
  });

  it("cai no padrão quando falta uma das pontas", () => {
    // Uma ponta só viraria intervalo aberto sem aviso — e relatório com metade
    // do período parece certo, que é o pior desfecho.
    const i = intervaloDoPeriodo("custom", { de: "2026-07-01" }, AGORA);
    const padrao = intervaloDoPeriodo(PERIODO_PADRAO, {}, AGORA);
    expect(i.primeiroDia).toBe(padrao.primeiroDia);
  });

  it("recusa data que não existe no calendário", () => {
    expect(ehDiaValido("2026-02-31")).toBe(false);
    expect(ehDiaValido("2026-13-01")).toBe(false);
    expect(ehDiaValido("11/08/2026")).toBe(false);
    expect(ehDiaValido("2026-02-28")).toBe(true);
  });
});

describe("normalização", () => {
  it("valor desconhecido vira o padrão", () => {
    expect(normalizarPeriodo("bananas")).toBe(PERIODO_PADRAO);
    expect(normalizarPeriodo(undefined)).toBe(PERIODO_PADRAO);
    expect(normalizarPeriodo("mes")).toBe("mes");
  });
});

describe("dias do intervalo", () => {
  it("enumera todos os dias, inclusive os sem gasto", () => {
    const i = intervaloDoPeriodo(
      "custom",
      { de: "2026-08-09", ate: "2026-08-11" },
      AGORA,
    );
    expect(diasDoIntervalo(i)).toEqual([
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
    ]);
  });

  it("no período tudo, usa o primeiro dia com dado", () => {
    const i = intervaloDoPeriodo("tudo", {}, AGORA);
    expect(diasDoIntervalo(i, "2026-08-10")).toEqual([
      "2026-08-10",
      "2026-08-11",
    ]);
  });

  it("sem dado nenhum no período tudo, devolve vazio em vez de estourar", () => {
    expect(diasDoIntervalo(intervaloDoPeriodo("tudo", {}, AGORA), null)).toEqual(
      [],
    );
  });

  it("não passa de dois anos de colunas", () => {
    const i = intervaloDoPeriodo(
      "custom",
      { de: "2020-01-01", ate: "2026-08-11" },
      AGORA,
    );
    expect(diasDoIntervalo(i).length).toBeLessThanOrEqual(732);
  });
});
