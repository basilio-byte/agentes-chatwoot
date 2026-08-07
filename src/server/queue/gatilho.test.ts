import { beforeEach, describe, expect, it, vi } from "vitest";

let adicionados: { nome: string; dados: unknown; opts: { jobId: string } }[];

vi.mock("./conexao", () => ({ getRedis: () => ({}) }));

vi.mock("bullmq", () => ({
  Queue: class {
    async add(nome: string, dados: unknown, opts: { jobId: string }) {
      adicionados.push({ nome, dados, opts });
      return { id: opts.jobId };
    }
  },
}));

const { agendarGatilho, getFilaGatilho } = await import("./gatilho");

beforeEach(() => {
  adicionados = [];
});

describe("agendarGatilho", () => {
  it("usa o webhookEventId como jobId — um job por entrega, não por agente", async () => {
    await agendarGatilho({
      agentId: "a1",
      webhookEventId: "evento-123",
      payload: { ok: true },
      eventType: "taskCreated",
    });

    expect(adicionados).toHaveLength(1);
    expect(adicionados[0].opts.jobId).toBe("gatilho-evento-123");
  });

  it("entregas diferentes viram jobs diferentes", async () => {
    await agendarGatilho({
      agentId: "a1",
      webhookEventId: "e1",
      payload: {},
      eventType: "x",
    });
    await agendarGatilho({
      agentId: "a1",
      webhookEventId: "e2",
      payload: {},
      eventType: "x",
    });

    expect(adicionados.map((a) => a.opts.jobId)).toEqual([
      "gatilho-e1",
      "gatilho-e2",
    ]);
  });
});

describe("getFilaGatilho", () => {
  it("reusa a mesma instância entre chamadas — não recria a fila a cada job", () => {
    expect(getFilaGatilho()).toBe(getFilaGatilho());
  });
});
