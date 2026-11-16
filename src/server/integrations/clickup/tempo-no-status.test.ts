import { describe, expect, it } from "vitest";

import { lerTempoNoStatus } from "./tempo-no-status";

describe("lerTempoNoStatus", () => {
  it("lê o formato cru da API: total_time.since", () => {
    const r = lerTempoNoStatus({
      "86adx9aak": {
        current_status: {
          status: "renovação",
          color: "#aa8d80",
          total_time: { by_minute: 7468, since: "1794380572408" },
        },
        status_history: [],
      },
    });
    expect(r["86adx9aak"]).toEqual({ status: "renovação", desde: 1794380572408 });
  });

  it("lê o formato simplificado do conector: current_status.since", () => {
    const r = lerTempoNoStatus({
      abc: { current_status: { status: "ongoing", total_time: "5d", since: "1794380602651" } },
    });
    expect(r.abc).toEqual({ status: "ongoing", desde: 1794380602651 });
  });

  it("aceita a resposta embrulhada em `tasks`", () => {
    const r = lerTempoNoStatus({
      tasks: { t1: { current_status: { status: "x", total_time: { since: 1700000000000 } } } },
    });
    expect(r.t1.desde).toBe(1700000000000);
  });

  it("⚠ sem o instante, `desde` é nulo — nunca zero", () => {
    const r = lerTempoNoStatus({
      a: { current_status: { status: "renovação", total_time: { since: "" } } },
      b: { current_status: { status: "renovação", total_time: { since: "lixo" } } },
      c: { current_status: { status: "renovação" } },
    });
    expect(r.a.desde).toBeNull();
    expect(r.b.desde).toBeNull();
    expect(r.c.desde).toBeNull();
  });

  it("tarefa sem current_status é ignorada, e resposta torta vira mapa vazio", () => {
    expect(lerTempoNoStatus({ a: {} })).toEqual({});
    expect(lerTempoNoStatus(null)).toEqual({});
    expect(lerTempoNoStatus("erro")).toEqual({});
  });
});
