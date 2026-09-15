import { describe, expect, it } from "vitest";
import { lerConversaResolvida } from "./evento";

/** O formato real da entrega de `conversation_status_changed` (15/09/2026), com contato fictício. */
const resolvida = (extra: Record<string, unknown> = {}) => ({
  event: "conversation_status_changed",
  id: 13498,
  inbox_id: 29,
  status: "resolved",
  updated_at: 1789485438.52,
  timestamp: 1789485400,
  meta: {
    sender: { name: "Maria", phone_number: "+558487654321" },
    assignee: null,
  },
  messages: [{ id: 1, conversation: { assignee_id: null } }],
  ...extra,
});

describe("lerConversaResolvida", () => {
  it("lê a conversa do TOPO do payload, que é onde este evento a manda", () => {
    expect(lerConversaResolvida(resolvida())).toEqual({
      conversationId: 13498,
      inboxId: 29,
      resolvidaEm: 1789485438,
      contatoNome: "Maria",
      telefone: "+558487654321",
    });
  });

  it("só a resolução conta: status aberto não dispara", () => {
    expect(lerConversaResolvida(resolvida({ status: "open" }))).toBeNull();
    expect(lerConversaResolvida(resolvida({ status: "pending" }))).toBeNull();
  });

  it("⚠ conversation_updated de conversa resolvida NÃO dispara", () => {
    // Cada automação que tira uma etiqueta depois de resolver manda um destes,
    // com status "resolved". Contar seria pagar a mesma avaliação várias vezes.
    expect(
      lerConversaResolvida(resolvida({ event: "conversation_updated" })),
    ).toBeNull();
    expect(
      lerConversaResolvida(resolvida({ event: "message_created" })),
    ).toBeNull();
  });

  it("sem id de conversa não há o que avaliar", () => {
    expect(lerConversaResolvida(resolvida({ id: undefined }))).toBeNull();
    expect(lerConversaResolvida(resolvida({ id: "abc" }))).toBeNull();
  });

  it("sem updated_at usa o timestamp; sem nenhum, a chegada", () => {
    expect(
      lerConversaResolvida(resolvida({ updated_at: null }))?.resolvidaEm,
    ).toBe(1789485400);
    expect(
      lerConversaResolvida(
        resolvida({ updated_at: null, timestamp: null }),
        1_789_000_000_000,
      )?.resolvidaEm,
    ).toBe(1_789_000_000);
  });

  it("contato sem nome ou telefone vira nulo, não texto vazio", () => {
    const lida = lerConversaResolvida(
      resolvida({ meta: { sender: { name: "  ", phone_number: null } } }),
    );
    expect(lida?.contatoNome).toBeNull();
    expect(lida?.telefone).toBeNull();
  });
});
