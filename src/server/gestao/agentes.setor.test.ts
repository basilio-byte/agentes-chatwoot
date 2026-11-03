import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O setor do agente: o que NÃO pode acontecer ao mexer em outro campo.
 *
 * ⚠ O serviço de agentes é um formulário só: o MCP monta o objeto inteiro a
 * partir do agente atual e troca o campo que a pessoa pediu. Se `setor` ausente
 * fosse lido como "vazio", qualquer ajuste de modelo ou de prompt pelo MCP
 * apagaria o setor que o painel gravou — sem erro e sem ninguém ver.
 */

const tx = vi.hoisted(() => ({
  agent: { update: vi.fn(), updateMany: vi.fn() },
  agentVersion: { findFirst: vi.fn(), create: vi.fn() },
}));
const db = vi.hoisted(() => ({
  agent: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  integration: { findUnique: vi.fn() },
  agentIntegration: { create: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/agents/catalogo", () => ({
  EFFORTS: ["none", "low", "medium", "high"],
  // Lista de reserva: o serviço não confere o modelo.
  listarModelos: async () => [],
}));
vi.mock("@/server/conhecimento/consulta", () => ({
  setoresGravados: vi.fn(async () => ["Comercial", null]),
}));

const { atualizarAgente, criarAgente } = await import("./agentes");

const autor = { userId: "u1", nome: "Teste" };
const agenteAtual = {
  id: "a1",
  name: "Vendas",
  systemPrompt: "x".repeat(40),
  model: "openai/gpt-5.6-luna",
  effort: "medium",
};
const formulario = {
  name: "Vendas",
  description: "",
  systemPrompt: "x".repeat(40),
  model: "openai/gpt-5.6-luna",
  effort: "medium",
  maxTokens: 16384,
  maxToolIterations: 12,
  routingDescription: "",
  persona: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  db.agent.findUnique.mockResolvedValue(agenteAtual);
  db.agent.findMany.mockResolvedValue([]);
  db.agent.create.mockResolvedValue({ id: "novo", key: "vendas" });
  db.integration.findUnique.mockResolvedValue(null);
  db.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
});

function gravado() {
  return tx.agent.update.mock.calls[0][0].data as Record<string, unknown>;
}

describe("atualizarAgente — setor", () => {
  it("sem a chave setor, o que está gravado fica como está", async () => {
    const r = await atualizarAgente("a1", formulario as never, autor);

    expect(r.ok).toBe(true);
    expect(gravado()).not.toHaveProperty("setor");
  });

  it("setor vazio tira o setor", async () => {
    await atualizarAgente("a1", { ...formulario, setor: "" } as never, autor);
    expect(gravado().setor).toBeNull();
  });

  it("reaproveita a grafia que já existe, sem diferenciar caixa", async () => {
    await atualizarAgente("a1", { ...formulario, setor: "  COMERCIAL " } as never, autor);
    expect(gravado().setor).toBe("Comercial");
  });

  it("setor novo vale como foi escrito", async () => {
    await atualizarAgente("a1", { ...formulario, setor: "Jurídico" } as never, autor);
    expect(gravado().setor).toBe("Jurídico");
  });

  it("recusa setor comprido demais, sem gravar", async () => {
    const r = await atualizarAgente(
      "a1",
      { ...formulario, setor: "x".repeat(41) } as never,
      autor,
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.camposComErro).toHaveProperty("setor");
    expect(tx.agent.update).not.toHaveBeenCalled();
  });

  it("mudar só o setor não cria versão do prompt", async () => {
    const r = await atualizarAgente("a1", { ...formulario, setor: "Comercial" } as never, autor);

    expect(r).toEqual({ ok: true, mudouComportamento: false, versao: null });
    expect(tx.agentVersion.create).not.toHaveBeenCalled();
  });
});

describe("criarAgente — setor", () => {
  beforeEach(() => {
    // Nenhum agente com esse nome ainda.
    db.agent.findUnique.mockResolvedValue(null);
  });

  it("nasce com o setor reconciliado", async () => {
    await criarAgente({ ...formulario, setor: "comercial" } as never, autor);
    expect(db.agent.create.mock.calls[0][0].data.setor).toBe("Comercial");
  });

  it("sem setor, nasce sem setor", async () => {
    await criarAgente({ ...formulario, setor: "" } as never, autor);
    expect(db.agent.create.mock.calls[0][0].data.setor).toBeNull();
  });
});
