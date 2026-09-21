import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RunSource } from "@/generated/prisma/enums";
import { ExecucaoInterrompida } from "./cancelamento";
import type { ResolucaoDoMotor } from "./motor";

/**
 * O runner com os dois motores. O que não pode errar, pela condição do usuário
 * (21/09/2026): *"não quebrar nosso sistema atual"*. Com o motor na OpenRouter,
 * a chamada sai IGUAL à de antes — mesmos campos, mesmo custo. E o proxy que
 * falha não pode deixar o cliente sem resposta: a mesma chamada vai para a
 * OpenRouter.
 */

type Chamada = Record<string, unknown>;
type Resposta = { choices: unknown[]; usage?: Record<string, unknown> };

let plano: ResolucaoDoMotor;
let openrouterConfigurada: boolean;
let respostasOpenRouter: Array<Resposta | Error>;
let respostasProxy: Array<Resposta | Error>;
let chamadasOpenRouter: Chamada[];
let chamadasProxy: Chamada[];
let atualizacoes: Record<string, unknown>[];
let toolsExecutadas: string[];

const AGENTE = {
  id: "ag-1",
  model: "z-ai/glm-5.3-flash",
  effort: "medium",
  maxTokens: 16384,
  maxToolIterations: 12,
  motor: "PADRAO",
  modeloClaudeMax: null,
};

vi.mock("@/lib/db", () => ({
  db: {
    agent: { findUniqueOrThrow: async () => AGENTE },
    agentRun: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        atualizacoes.push({ criacao: true, ...data });
        return { id: "run-1" };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        atualizacoes.push(data);
        return {};
      },
    },
    toolCall: { create: async () => ({}) },
  },
}));

vi.mock("./contexto", () => ({
  prepararContexto: async () => ({
    resolvidas: new Map([
      [
        "consultar",
        {
          provider: "CLICKUP",
          configuracao: { config: {}, credential: null },
          definicao: {
            inputSchema: z.object({ q: z.string() }),
            execute: async ({ q }: { q: string }) => {
              toolsExecutadas.push(q);
              return { achado: q };
            },
          },
        },
      ],
    ]),
    ferramentas: [{ type: "function", function: { name: "consultar", parameters: {} } }],
    modelo: { id: AGENTE.model, suportaTools: true, suportaReasoning: true, maxSaida: 8000 },
    enviarFerramentas: true,
    systemPrompt: "PROMPT DO AGENTE",
  }),
}));

const proxima = (fila: Array<Resposta | Error>) => {
  const item = fila.shift();
  if (!item) throw new Error("teste: nenhuma resposta sobrando");
  if (item instanceof Error) throw item;
  return item;
};

vi.mock("./openrouter", () => ({
  PREFERENCIA_DE_PROVEDOR: { sort: "throughput" },
  openrouterConfigurada: () => openrouterConfigurada,
  getOpenRouter: () => {
    if (!openrouterConfigurada) throw new Error("OPENROUTER_API_KEY não configurada.");
    return {
      chat: {
        completions: {
          create: async (parametros: Chamada) => {
            chamadasOpenRouter.push(structuredClone(parametros));
            return proxima(respostasOpenRouter);
          },
        },
      },
    };
  },
}));

vi.mock("./claude-max", () => ({
  planejarMotor: async () => plano,
  obterModeloClaudeMax: async (id: string) => ({ id, nome: id, contexto: null, maxSaida: 64000 }),
  getClaudeMax: () => ({
    chat: {
      completions: {
        create: async (parametros: Chamada) => {
          chamadasProxy.push(structuredClone(parametros));
          return proxima(respostasProxy);
        },
      },
    },
  }),
}));

vi.mock("./cancelamento", async (original) => ({
  ...(await original<typeof import("./cancelamento")>()),
  conferirParada: async () => {},
  limparPedido: async () => {},
  comParadaVigiada: async (_runId: string, executar: (s: AbortSignal) => Promise<unknown>) =>
    executar(new AbortController().signal),
}));

const { executarAgente } = await import("./runner");

const final = (texto: string, custo?: number): Resposta => ({
  choices: [{ message: { role: "assistant", content: texto }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 20, ...(custo !== undefined ? { cost: custo } : {}) },
});

const pedeTool = (q: string): Resposta => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: `call-${q}`, type: "function", function: { name: "consultar", arguments: JSON.stringify({ q }) } }],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 50, completion_tokens: 5 },
});

const falha = (status: number, mensagem = "falhou") => Object.assign(new Error(mensagem), { status });

const rodar = () =>
  executarAgente({
    agentId: AGENTE.id,
    source: RunSource.CHATWOOT,
    mensagem: "oi",
    conversationId: "conv-1",
  });

const finalDaExecucao = () => atualizacoes.at(-1)!;

const OPENROUTER: ResolucaoDoMotor = { motor: "OPENROUTER", modeloClaude: null, porque: "chave desligada" };
const CLAUDE_MAX: ResolucaoDoMotor = { motor: "CLAUDE_MAX", modeloClaude: "claude-sonnet-5", porque: "fixado" };

beforeEach(() => {
  plano = OPENROUTER;
  openrouterConfigurada = true;
  respostasOpenRouter = [];
  respostasProxy = [];
  chamadasOpenRouter = [];
  chamadasProxy = [];
  atualizacoes = [];
  toolsExecutadas = [];
});

describe("motor OpenRouter — o sistema de antes", () => {
  it("⚠ a chamada sai com os mesmos campos de sempre, e o custo é o que ela cobra", async () => {
    respostasOpenRouter = [final("olá", 0.0015)];
    const r = await rodar();

    expect(chamadasProxy).toEqual([]);
    expect(chamadasOpenRouter).toHaveLength(1);
    const { messages, tools, ...resto } = chamadasOpenRouter[0];
    expect(resto).toEqual({
      model: "z-ai/glm-5.3-flash",
      max_tokens: 8000, // cortado pelo limite do modelo, como antes
      usage: { include: true },
      provider: { sort: "throughput" },
      reasoning: { effort: "medium" },
    });
    expect(tools).toHaveLength(1);
    expect((messages as Chamada[])[0]).toEqual({ role: "system", content: "PROMPT DO AGENTE" });

    expect(r.custoUsd).toBe(0.0015);
    expect(finalDaExecucao()).toMatchObject({
      status: "SUCCESS",
      model: "z-ai/glm-5.3-flash",
      motor: "OPENROUTER",
      voltaDoProxy: null,
      costUsd: 0.0015,
    });
  });
});

describe("motor Claude MAX", () => {
  it("vai só ao proxy, com o protocolo puro, e não custa nada", async () => {
    plano = CLAUDE_MAX;
    respostasProxy = [final("olá do Claude")];
    const r = await rodar();

    expect(chamadasOpenRouter).toEqual([]);
    const { messages, tools, ...resto } = chamadasProxy[0];
    // Nada de provider, usage nem reasoning: o proxy ignora, e o esforço é dele.
    expect(resto).toEqual({ model: "claude-sonnet-5", max_tokens: 16384, user: "conversa:conv-1" });
    expect(tools).toHaveLength(1);
    // Prompt, data/hora e a mensagem: as mesmas que iriam à OpenRouter.
    expect((messages as Array<{ role: string }>).map((m) => m.role)).toEqual(["system", "system", "user"]);

    expect(r.resposta).toBe("olá do Claude");
    expect(r.custoUsd).toBe(0);
    expect(atualizacoes[0]).toMatchObject({ criacao: true, model: "claude-max/claude-sonnet-5", motor: "CLAUDE_MAX" });
    expect(finalDaExecucao()).toMatchObject({
      model: "claude-max/claude-sonnet-5",
      motor: "CLAUDE_MAX",
      voltaDoProxy: null,
      costUsd: 0,
    });
  });

  it("ferramenta pedida pelo Claude é executada aqui, e o resultado volta a ele", async () => {
    plano = CLAUDE_MAX;
    respostasProxy = [pedeTool("sala 3"), final("a sala 3 está livre")];
    const r = await rodar();

    expect(toolsExecutadas).toEqual(["sala 3"]);
    expect(chamadasProxy).toHaveLength(2);
    const segunda = chamadasProxy[1].messages as Array<{ role: string; content?: unknown }>;
    expect(segunda.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-sala 3" });
    expect(r.resposta).toBe("a sala 3 está livre");
  });

  it("⚠ proxy falhou: a MESMA etapa vai para a OpenRouter, e o resto do turno fica nela", async () => {
    plano = CLAUDE_MAX;
    respostasProxy = [falha(503, "fila cheia")];
    respostasOpenRouter = [pedeTool("sala 3"), final("respondido pela OpenRouter", 0.002)];
    const r = await rodar();

    expect(chamadasProxy).toHaveLength(1); // não insiste no proxy depois da falha
    expect(chamadasOpenRouter).toHaveLength(2);
    expect(chamadasOpenRouter[0]).toMatchObject({ model: "z-ai/glm-5.3-flash", provider: { sort: "throughput" } });
    expect(r.resposta).toBe("respondido pela OpenRouter");
    expect(r.custoUsd).toBe(0.002);
    expect(finalDaExecucao()).toMatchObject({
      status: "SUCCESS",
      model: "z-ai/glm-5.3-flash",
      motor: "OPENROUTER",
      voltaDoProxy: "a fila do proxy estava cheia (503)",
    });
  });

  it("proxy falhou numa etapa do meio: o que já rodou nele vale, e só a OpenRouter cobra", async () => {
    plano = CLAUDE_MAX;
    respostasProxy = [pedeTool("sala 3"), falha(429, "usage limit reached")];
    respostasOpenRouter = [final("fechado pela OpenRouter", 0.001)];
    const r = await rodar();

    expect(toolsExecutadas).toEqual(["sala 3"]); // a ferramenta não roda de novo
    expect(r.custoUsd).toBe(0.001);
    expect(finalDaExecucao()).toMatchObject({
      voltaDoProxy: "a cota da assinatura acabou, ou o proxy limitou as chamadas (429)",
    });
  });

  it("⚠ parada no painel NÃO volta para a OpenRouter", async () => {
    plano = CLAUDE_MAX;
    respostasProxy = [new ExecucaoInterrompida("run-1", "Fulana")];

    await expect(rodar()).rejects.toThrow("interrompida no painel");
    expect(chamadasOpenRouter).toEqual([]);
    expect(finalDaExecucao()).toMatchObject({ status: "CANCELED", voltaDoProxy: null });
  });

  it("sem OpenRouter configurada não há para onde voltar: o erro do proxy fica registrado", async () => {
    plano = CLAUDE_MAX;
    openrouterConfigurada = false;
    respostasProxy = [falha(503, "fila cheia")];

    await expect(rodar()).rejects.toThrow("fila cheia");
    expect(finalDaExecucao()).toMatchObject({ status: "ERROR", motor: "CLAUDE_MAX", error: "fila cheia" });
  });

  it("proxy e OpenRouter falharam: a execução guarda as duas causas", async () => {
    plano = CLAUDE_MAX;
    respostasProxy = [falha(401, "not logged in")];
    respostasOpenRouter = [falha(500, "openrouter caiu")];

    await expect(rodar()).rejects.toThrow("openrouter caiu");
    expect(finalDaExecucao()).toMatchObject({
      status: "ERROR",
      motor: "OPENROUTER",
      error: "openrouter caiu",
      voltaDoProxy: "o login da assinatura no proxy está vencido ou foi recusado (401)",
    });
  });
});
