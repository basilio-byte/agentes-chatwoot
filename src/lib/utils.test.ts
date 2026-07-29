import { describe, expect, it } from "vitest";
import { formatarData } from "./utils";

/**
 * O painel roda como componente de servidor, e o container do Easypanel está em
 * UTC. Sem fuso fixo, "última alteração" aparecia adiantada — 14:15 no painel
 * enquanto o agente, esse com fuso fixo, dizia 11:20.
 *
 * As expectativas abaixo valem em qualquer máquina justamente porque o fuso é
 * fixo: numa máquina em UTC, antes da correção, todas falhariam.
 */
describe("formatarData", () => {
  it("mostra o horário de São Paulo, não o do servidor", () => {
    expect(formatarData("2026-07-29T14:15:00Z")).toBe("29/07/2026, 11:15");
  });

  it("aceita Date e string do banco igualmente", () => {
    const instante = "2026-07-29T14:15:00Z";
    expect(formatarData(new Date(instante))).toBe(formatarData(instante));
  });

  it("vira o dia no horário certo — 02:30 UTC ainda é ontem no Brasil", () => {
    expect(formatarData("2026-07-29T02:30:00Z")).toBe("28/07/2026, 23:30");
  });

  it("acompanha o horário de verão do hemisfério norte sem se mexer", () => {
    // São Paulo não tem mais horário de verão: janeiro e julho, ambos UTC-3.
    expect(formatarData("2026-01-15T14:00:00Z")).toBe("15/01/2026, 11:00");
    expect(formatarData("2026-07-15T14:00:00Z")).toBe("15/07/2026, 11:00");
  });
});
