import { describe, expect, it } from "vitest";
import { ehResolvida, podeAgir, precisaAbrir } from "./regras";

describe("regra 1 — não interferir em conversa de humano", () => {
  it("cala quando existe responsável humano, mesmo com a conversa aberta", () => {
    const r = podeAgir({ status: "open", assigneeId: 42 });

    expect(r.pode).toBe(false);
    if (!r.pode) expect(r.motivo).toContain("humano");
  });

  it("cala mesmo em conversa pendente atribuída", () => {
    expect(podeAgir({ status: "pending", assigneeId: 7 }).pode).toBe(false);
  });

  it("age quando o responsável foi removido", () => {
    expect(podeAgir({ status: "open", assigneeId: null }).pode).toBe(true);
    expect(podeAgir({ status: "pending" }).pode).toBe(true);
  });
});

describe("regra 2 — não interagir em conversa resolvida", () => {
  it("cala em conversa resolvida", () => {
    const r = podeAgir({ status: "resolved" });

    expect(r.pode).toBe(false);
    if (!r.pode) {
      expect(r.motivo).toContain("resolvida");
      expect(r.resolvida).toBe(true);
    }
  });

  it("sinaliza a resolução para quem precisa cortar o histórico", () => {
    const r = podeAgir({ status: "RESOLVED" }); // caixa não importa
    expect(r.pode).toBe(false);
    if (!r.pode) expect(r.resolvida).toBe(true);
  });

  it("cala em qualquer status fora do permitido", () => {
    expect(podeAgir({ status: "snoozed" }).pode).toBe(false);
  });

  it("age em aberta e pendente sem responsável", () => {
    expect(podeAgir({ status: "open" }).pode).toBe(true);
    expect(podeAgir({ status: "pending" }).pode).toBe(true);
  });

  it("sem status informado, não bloqueia por status", () => {
    expect(podeAgir({}).pode).toBe(true);
  });
});

describe("detecção de resolução", () => {
  it("reconhece independentemente da caixa", () => {
    expect(ehResolvida("resolved")).toBe(true);
    expect(ehResolvida("Resolved")).toBe(true);
    expect(ehResolvida("open")).toBe(false);
    expect(ehResolvida(null)).toBe(false);
    expect(ehResolvida(undefined)).toBe(false);
  });
});

describe("precedência", () => {
  it("humano vence resolvida na explicação — o motivo mais acionável", () => {
    const r = podeAgir({ status: "resolved", assigneeId: 9 });
    expect(r.pode).toBe(false);
    if (!r.pode) expect(r.motivo).toContain("humano");
  });
});

describe("o bot nunca deixa a conversa pendente", () => {
  it("pendente precisa ser aberta", () => {
    // `pending` não aparece na visualização padrão do Chatwoot: a conversa
    // ficaria invisível para a equipe enquanto o bot a atende.
    expect(precisaAbrir("pending")).toBe(true);
  });

  it("aberta não vira chamada à toa", () => {
    expect(precisaAbrir("open")).toBe(false);
  });

  it("resolvida não é reaberta pelo bot", () => {
    // Encerrar e reabrir atendimento é decisão de pessoa. Além disso o agente
    // nem chega aqui: `podeAgir` já o barrou.
    expect(precisaAbrir("resolved")).toBe(false);
  });

  it("status ausente ou desconhecido não dispara nada", () => {
    expect(precisaAbrir(null)).toBe(false);
    expect(precisaAbrir(undefined)).toBe(false);
    expect(precisaAbrir("snoozed")).toBe(false);
  });

  it("o bot age em pendente, mas não termina nele", () => {
    // As duas regras juntas: pode atender a conversa que chega pendente...
    expect(podeAgir({ status: "pending" }).pode).toBe(true);
    // ...e tem de deixá-la aberta ao terminar.
    expect(precisaAbrir("pending")).toBe(true);
  });
});
