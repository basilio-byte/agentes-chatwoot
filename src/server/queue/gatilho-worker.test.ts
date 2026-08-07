import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { JobGatilho } from "./gatilho";

/**
 * O caso crítico deste worker: o BullMQ reexecuta o job INTEIRO em retry, e
 * uma tool que já rodou pode ter mudado algo de verdade num sistema externo
 * (ClickUp, Conexa, ZapSign). Falha DEPOIS disso não pode virar nova
 * tentativa — mesmo bug já corrigido para o atendimento do Chatwoot nesta
 * sessão, e aqui a arquitetura precisa nascer já protegida.
 */

let trigger: { enabled: boolean } | null;
let agente: { active: boolean; archivedAt: Date | null } | null;
let marcados: { webhookEventId: string; resultado: string; detalhe: string }[];
let toolCallCount: number;
let execucao: {
  resultado?: { runId: string; toolCalls: unknown[]; iteracoes: number };
  erro?: Error & { runId?: string };
};

vi.mock("@/lib/db", () => ({
  db: {
    agentTrigger: { findUnique: async () => trigger },
    agent: { findUnique: async () => agente },
    webhookEvent: {
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { resultado: string; detalhe: string };
      }) => {
        marcados.push({
          webhookEventId: where.id,
          resultado: data.resultado,
          detalhe: data.detalhe,
        });
      },
    },
    toolCall: { count: async () => toolCallCount },
  },
}));

vi.mock("@/server/agents/runner", () => ({
  executarAgente: async () => {
    if (execucao.erro) throw execucao.erro;
    return execucao.resultado;
  },
}));

const { processarGatilho } = await import("./gatilho-worker");

const job = (agentId = "agente-1") =>
  ({
    data: {
      agentId,
      webhookEventId: "evento-1",
      payload: { task_id: "abc" },
      eventType: "taskCreated",
    },
  }) as Job<JobGatilho>;

beforeEach(() => {
  trigger = { enabled: true };
  agente = { active: true, archivedAt: null };
  marcados = [];
  toolCallCount = 0;
  execucao = {};
});

describe("reconferência antes de executar", () => {
  it("gatilho desligado não roda o agente", async () => {
    trigger = { enabled: false };

    await processarGatilho(job());

    expect(marcados).toEqual([
      {
        webhookEventId: "evento-1",
        resultado: "ignorado",
        detalhe: "gatilho ou agente foi desligado antes da execução",
      },
    ]);
  });

  it("agente desligado não roda mesmo com o gatilho ligado", async () => {
    agente = { active: false, archivedAt: null };

    await processarGatilho(job());

    expect(marcados[0]?.resultado).toBe("ignorado");
  });

  it("agente arquivado não roda", async () => {
    agente = { active: true, archivedAt: new Date() };

    await processarGatilho(job());

    expect(marcados[0]?.resultado).toBe("ignorado");
  });
});

describe("execução bem-sucedida", () => {
  it("marca a entrega como executado, com o resumo do run", async () => {
    execucao.resultado = { runId: "run-1", toolCalls: [{}, {}], iteracoes: 2 };

    await processarGatilho(job());

    expect(marcados[0]?.resultado).toBe("executado");
    expect(marcados[0]?.detalhe).toContain("run-1");
    expect(marcados[0]?.detalhe).toContain("2 tool(s)");
  });
});

describe("falha ANTES de qualquer tool — seguro tentar de novo", () => {
  it("relança o erro, para o BullMQ tentar de novo", async () => {
    const erro = new Error("OpenRouter fora do ar");
    execucao.erro = erro; // sem .runId — executarAgente falhou antes de criar o AgentRun
    toolCallCount = 0;

    await expect(processarGatilho(job())).rejects.toThrow("OpenRouter fora do ar");
  });

  it("marca a entrega como falhou antes de relançar", async () => {
    execucao.erro = new Error("falha de preparação");
    toolCallCount = 0;

    await expect(processarGatilho(job())).rejects.toThrow();

    expect(marcados[0]).toEqual({
      webhookEventId: "evento-1",
      resultado: "falhou",
      detalhe: "falha de preparação",
    });
  });
});

describe("falha DEPOIS de uma tool já ter executado — não pode duplicar", () => {
  it("NÃO relança — o job termina sem erro, para o BullMQ não reprocessar", async () => {
    const erro = new Error("banco caiu ao gravar o resultado final") as Error & {
      runId?: string;
    };
    erro.runId = "run-2";
    execucao.erro = erro;
    toolCallCount = 3; // ToolCall já persistidas antes da falha

    await expect(processarGatilho(job())).resolves.toBeUndefined();
  });

  it("ainda assim marca a entrega como falhou, para o painel mostrar a causa", async () => {
    const erro = new Error("banco caiu") as Error & { runId?: string };
    erro.runId = "run-2";
    execucao.erro = erro;
    toolCallCount = 1;

    await processarGatilho(job());

    expect(marcados[0]).toEqual({
      webhookEventId: "evento-1",
      resultado: "falhou",
      detalhe: "banco caiu",
    });
  });

  it("erro com runId mas SEM tool persistida ainda relança — nada foi executado de fato", async () => {
    const erro = new Error("falhou antes de qualquer tool_call") as Error & {
      runId?: string;
    };
    erro.runId = "run-3";
    execucao.erro = erro;
    toolCallCount = 0;

    await expect(processarGatilho(job())).rejects.toThrow();
  });
});
