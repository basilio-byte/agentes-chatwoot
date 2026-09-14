import { describe, expect, it } from "vitest";
import { vereditoDaEscalada } from "./escalada";

describe("o vigia confere o Chatwoot ao vivo antes de escalar", () => {
  it("conversa com o bot, sem dono: escala", () => {
    expect(
      vereditoDaEscalada({ status: "open", assigneeId: null, assigneeTipo: null }),
    ).toEqual({ escalar: true });
  });

  it("o próprio robô como dono também escala", () => {
    // O Chatwoot atribui o Agent Bot sozinho em caixa com robô — é normal.
    expect(
      vereditoDaEscalada({ status: "pending", assigneeId: 4, assigneeTipo: "AgentBot" }),
    ).toEqual({ escalar: true });
  });

  it("⚠ uma pessoa já assumiu: não escala por cima", () => {
    expect(
      vereditoDaEscalada({ status: "open", assigneeId: 7, assigneeTipo: "User" }),
    ).toEqual({
      escalar: false,
      motivo: "conversa atribuída a um humano",
      resolvida: false,
      donoHumano: true,
    });
  });

  it("⚠ dono de tipo desconhecido conta como pessoa", () => {
    expect(
      vereditoDaEscalada({ status: "open", assigneeId: 7, assigneeTipo: null }),
    ).toMatchObject({ escalar: false, donoHumano: true });
  });

  it("resolvida: não escala, e não é caso de marcar como humana", () => {
    expect(
      vereditoDaEscalada({ status: "resolved", assigneeId: null, assigneeTipo: null }),
    ).toMatchObject({ escalar: false, resolvida: true, donoHumano: false });
  });

  it("adiada (snoozed): não escala", () => {
    expect(
      vereditoDaEscalada({ status: "snoozed", assigneeId: null, assigneeTipo: null }),
    ).toMatchObject({ escalar: false, resolvida: false, donoHumano: false });
  });
});
