import { describe, expect, it } from "vitest";

import {
  CAIXA_DO_CLIENTE,
  escolherConversa,
  ultimaFala,
  ultimoAtendente,
  type FalaDaConversa,
} from "./conversa";

function msg(extra: Partial<FalaDaConversa>): FalaDaConversa {
  return {
    id: 1,
    message_type: 1,
    created_at: 1762785600,
    sender: { type: "user", name: "Alan Novaes" },
    ...extra,
  };
}

describe("escolherConversa", () => {
  it("prefere a aberta mais recente da caixa do cliente", () => {
    const r = escolherConversa([
      { id: 10, caixaId: CAIXA_DO_CLIENTE, status: "open", ultimaAtividadeEm: 100 },
      { id: 11, caixaId: CAIXA_DO_CLIENTE, status: "open", ultimaAtividadeEm: 200 },
    ]);
    expect(r?.conversa.id).toBe(11);
    expect(r?.precisaReabrir).toBe(false);
  });

  it("`pending` não é resolvida e serve", () => {
    const r = escolherConversa([
      { id: 10, caixaId: CAIXA_DO_CLIENTE, status: "pending", ultimaAtividadeEm: 100 },
    ]);
    expect(r?.precisaReabrir).toBe(false);
  });

  it("só resolvida: usa a mais recente e marca para reabrir", () => {
    const r = escolherConversa([
      { id: 10, caixaId: CAIXA_DO_CLIENTE, status: "resolved", ultimaAtividadeEm: 100 },
      { id: 12, caixaId: CAIXA_DO_CLIENTE, status: "resolved", ultimaAtividadeEm: 300 },
    ]);
    expect(r?.conversa.id).toBe(12);
    expect(r?.precisaReabrir).toBe(true);
  });

  it("⚠ conversa de OUTRA caixa nunca entra — seria um fio paralelo", () => {
    expect(
      escolherConversa([{ id: 10, caixaId: 31, status: "open", ultimaAtividadeEm: 100 }]),
    ).toBeNull();
  });

  it("sem conversa nenhuma, devolve nulo em vez de inventar", () => {
    expect(escolherConversa([])).toBeNull();
  });
});

describe("ultimaFala", () => {
  it("é a de maior id, com quem escreveu e quando", () => {
    const r = ultimaFala([
      msg({ id: 1, sender: { type: "contact" } }),
      msg({ id: 2, sender: { type: "user", name: "Alan" }, created_at: 1762789200 }),
    ]);
    expect(r?.deQuem).toBe("equipe");
    expect(r?.em).toEqual(new Date(1762789200 * 1000));
  });

  it("⚠ mensagem de ATIVIDADE não é fala", () => {
    const r = ultimaFala([
      msg({ id: 1, sender: { type: "contact" } }),
      msg({ id: 9, message_type: 2, sender: null }),
    ]);
    expect(r?.deQuem).toBe("cliente");
  });

  it("⚠ nota interna CONTA: alguém está trabalhando a conversa agora", () => {
    const r = ultimaFala([msg({ id: 5, private: true, sender: { type: "user" } })]);
    expect(r?.deQuem).toBe("equipe");
  });

  it("o robô é reconhecido e não bloqueia", () => {
    expect(ultimaFala([msg({ id: 5, sender: { type: "agent_bot" } })])?.deQuem).toBe("robo");
  });

  it("⚠ sem `created_at`, trata como AGORA — o lado seguro da trava", () => {
    const antes = Date.now();
    const r = ultimaFala([msg({ id: 5, created_at: null })]);
    expect(r!.em.getTime()).toBeGreaterThanOrEqual(antes);
  });

  it("conversa só com atividades não tem fala", () => {
    expect(ultimaFala([msg({ id: 1, message_type: 2, sender: null })])).toBeNull();
    expect(ultimaFala([])).toBeNull();
  });
});

describe("ultimoAtendente", () => {
  it("devolve o nome da última PESSOA que escreveu", () => {
    expect(
      ultimoAtendente([
        msg({ id: 1, sender: { type: "user", name: "Arthur George" } }),
        msg({ id: 2, sender: { type: "user", name: "Alan Novaes" } }),
        msg({ id: 3, sender: { type: "agent_bot", name: "Seahub" } }),
      ]),
    ).toBe("Alan Novaes");
  });

  it("⚠ o robô não conta: devolver a conversa a ele é deixá-la sem dono", () => {
    expect(ultimoAtendente([msg({ id: 1, sender: { type: "agent_bot", name: "Seahub" } })])).toBeNull();
  });

  it("pessoa sem nome é pulada até achar uma com nome", () => {
    expect(
      ultimoAtendente([
        msg({ id: 1, sender: { type: "user", name: "Kelly" } }),
        msg({ id: 2, sender: { type: "user", name: "  " } }),
      ]),
    ).toBe("Kelly");
  });

  it("só cliente no histórico: ninguém para devolver", () => {
    expect(ultimoAtendente([msg({ id: 1, sender: { type: "contact", name: "Carla" } })])).toBeNull();
  });
});
