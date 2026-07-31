import { describe, expect, it } from "vitest";
import { lerConversa } from "./resolucao";

/**
 * O formato muda conforme o evento, e errar isso fez a resolução passar batido
 * em produção: o evento chegava, era registrado e não fazia nada.
 */
describe("de onde sai o id e o status da conversa", () => {
  it("message_created traz a conversa aninhada", () => {
    expect(
      lerConversa({
        event: "message_created",
        id: 991, // id da MENSAGEM
        conversation: { id: 55, status: "open" },
      }),
    ).toEqual({ conversationId: 55, status: "open" });
  });

  it("conversation_status_changed É a conversa: id no topo", () => {
    expect(
      lerConversa({ event: "conversation_status_changed", id: 55, status: "resolved" }),
    ).toEqual({ conversationId: 55, status: "resolved" });
  });

  it("conversation_updated também vem no topo", () => {
    expect(
      lerConversa({ event: "conversation_updated", id: 55, status: "resolved" }),
    ).toEqual({ conversationId: 55, status: "resolved" });
  });

  it("id de mensagem NUNCA vira id de conversa", () => {
    // Sem esta guarda, um message_created sem conversa aninhada apontaria para
    // a conversa de número igual ao id da mensagem — e resolveria a errada.
    expect(lerConversa({ event: "message_created", id: 991 })).toEqual({});
  });

  it("aninhado ganha do topo quando os dois vêm", () => {
    expect(
      lerConversa({
        event: "conversation_updated",
        id: 991,
        status: "open",
        conversation: { id: 55, status: "resolved" },
      }),
    ).toEqual({ conversationId: 55, status: "resolved" });
  });

  it("id de conversa em texto é aceito", () => {
    expect(
      lerConversa({ event: "conversation_updated", id: "55", status: "resolved" }),
    ).toMatchObject({ conversationId: 55 });
  });

  it("id inválido não vira zero nem NaN", () => {
    expect(
      lerConversa({ event: "conversation_updated", id: "abc", status: "resolved" })
        .conversationId,
    ).toBeUndefined();
  });
});
