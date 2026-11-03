import { describe, expect, it, vi } from "vitest";
import { SEM_SETOR } from "@/lib/setor";

vi.mock("@/lib/db", () => ({ db: {} }));

const { montarWhere } = await import("./consulta");
const { intervaloDoPeriodo } = await import("./periodo");

const intervalo = intervaloDoPeriodo("tudo");

describe("montarWhere — setor", () => {
  it("sem setor, o filtro não toca no agente (Consumo e CSV seguem como eram)", () => {
    expect(montarWhere({ intervalo })).not.toHaveProperty("agent");
    expect(montarWhere({ intervalo, setor: "" })).not.toHaveProperty("agent");
    expect(montarWhere({ intervalo, setor: null })).not.toHaveProperty("agent");
  });

  it("filtra pelo setor do agente, sem diferenciar caixa", () => {
    expect(montarWhere({ intervalo, setor: "Comercial" }).agent).toEqual({
      setor: { equals: "Comercial", mode: "insensitive" },
    });
  });

  it("'sem setor' pega só os agentes sem setor", () => {
    expect(montarWhere({ intervalo, setor: SEM_SETOR }).agent).toEqual({ setor: null });
  });

  it("combina com os outros filtros", () => {
    const where = montarWhere({ intervalo, agentId: "a1", setor: "Comercial" });
    expect(where.agentId).toBe("a1");
    expect(where.agent).toBeDefined();
  });
});
