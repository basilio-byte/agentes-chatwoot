import { describe, expect, it } from "vitest";
import { decidirSeResponde } from "./eventos";

function evento(extra: Record<string, unknown> = {}) {
  return {
    event: "message_created",
    id: 1,
    content: "Vocês têm sala para 4 pessoas?",
    message_type: "incoming",
    sender: { id: 9, type: "contact", name: "Ana" },
    conversation: {
      id: 55,
      status: "pending",
      meta: { sender: { name: "Ana", phone_number: "+5511999999999" } },
    },
    inbox: { id: 3, name: "WhatsApp" },
    ...extra,
  };
}

describe("decisão de responder", () => {
  it("responde mensagem de contato numa conversa pendente", () => {
    const d = decidirSeResponde(evento());

    expect(d.responder).toBe(true);
    if (!d.responder) return;
    expect(d.conversationId).toBe(55);
    expect(d.inboxId).toBe(3);
    expect(d.texto).toBe("Vocês têm sala para 4 pessoas?");
    expect(d.contato.nome).toBe("Ana");
    expect(d.contato.identificador).toBe("+5511999999999");
  });

  it("ignora o próprio eco — a defesa contra loop de bot", () => {
    const d = decidirSeResponde(evento({ message_type: "outgoing" }));

    expect(d).toEqual({ responder: false, motivo: "message_type outgoing" });
  });

  it("ignora mensagem enviada por agent_bot", () => {
    const d = decidirSeResponde(
      evento({ sender: { id: 7, type: "agent_bot", name: "Atendente" } }),
    );

    expect(d.responder).toBe(false);
  });

  it("ignora nota privada da equipe", () => {
    expect(decidirSeResponde(evento({ private: true }))).toEqual({
      responder: false,
      motivo: "nota privada",
    });
  });

  it("cala quando um humano assumiu a conversa", () => {
    const d = decidirSeResponde(
      evento({
        conversation: { id: 55, status: "open", assignee_id: 4 },
      }),
    );

    expect(d).toEqual({
      responder: false,
      motivo: "conversa atribuída a um humano",
    });
  });

  it("também respeita o responsável vindo em meta.assignee", () => {
    const d = decidirSeResponde(
      evento({
        conversation: { id: 55, status: "open", meta: { assignee: { id: 4 } } },
      }),
    );

    expect(d.responder).toBe(false);
  });

  it("não responde conversa resolvida", () => {
    const d = decidirSeResponde(
      evento({ conversation: { id: 55, status: "resolved" } }),
    );

    expect(d).toEqual({ responder: false, motivo: "conversa resolvida" });
  });

  it("ignora outros eventos", () => {
    expect(
      decidirSeResponde({ event: "conversation_typing_on" }),
    ).toEqual({ responder: false, motivo: "evento conversation_typing_on não responde" });
  });

  it("ignora mensagem sem texto (anexo puro)", () => {
    expect(decidirSeResponde(evento({ content: "   " }))).toEqual({
      responder: false,
      motivo: "mensagem sem texto (anexo?)",
    });
  });

  it("não estoura com payload fora do formato", () => {
    expect(decidirSeResponde({ lixo: true })).toEqual({
      responder: false,
      motivo: "payload em formato inesperado",
    });
    expect(decidirSeResponde(null).responder).toBe(false);
  });

  it("aceita campos desconhecidos sem reclamar", () => {
    // O payload varia entre versões e canais — campo novo não pode quebrar.
    const d = decidirSeResponde(
      evento({ campo_novo_do_chatwoot: { qualquer: "coisa" } }),
    );

    expect(d.responder).toBe(true);
  });
});

describe("de onde vem o id da caixa", () => {
  const base = {
    event: "message_created",
    id: 1,
    message_type: "incoming",
    content: "quero uma sala",
    conversation: { id: 55, status: "pending", assignee_id: null },
  };

  it("aceita no topo, que é onde message_created costuma trazer", () => {
    const d = decidirSeResponde({ ...base, inbox: { id: 7 } });
    expect(d).toMatchObject({ responder: true, inboxId: 7 });
  });

  it("aceita dentro da conversa — variação de payload não pode virar silêncio", () => {
    const d = decidirSeResponde({
      ...base,
      conversation: { ...base.conversation, inbox_id: 9 },
    });
    expect(d).toMatchObject({ responder: true, inboxId: 9 });
  });

  it("o topo ganha quando os dois vêm", () => {
    const d = decidirSeResponde({
      ...base,
      inbox: { id: 7 },
      conversation: { ...base.conversation, inbox_id: 9 },
    });
    expect(d).toMatchObject({ responder: true, inboxId: 7 });
  });

  it("sem nenhum dos dois, o motivo diz onde procurar", () => {
    const d = decidirSeResponde(base);
    expect(d.responder).toBe(false);
    expect(d.responder === false && d.motivo).toContain("conversation.inbox_id");
  });
});
