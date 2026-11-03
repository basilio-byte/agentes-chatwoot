import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunSource } from "@/generated/prisma/enums";

const documentos = vi.hoisted(() => ({
  lista: [] as { nome: string; descricao: string | null; setor: string | null; texto: string }[],
}));

vi.mock("@/lib/db", () => ({ db: { agent: { findMany: async () => [] } } }));
vi.mock("@/server/integrations/resolve", () => ({
  resolverToolsDoAgente: async () => new Map(),
  paraFerramentasOpenAI: () => [],
}));
vi.mock("./catalogo", () => ({ obterModelo: async () => null }));
vi.mock("@/server/conhecimento/consulta", () => ({
  documentosDoAgente: async () => documentos.lista,
}));

const { prepararContexto } = await import("./contexto");

const agente = {
  id: "a1",
  name: "Vendas",
  systemPrompt: "Você é o atendente de vendas da Seahub.",
  model: "openai/gpt-5.6-luna",
  handoffEnabled: true,
};

const playbook = {
  nome: "Playbook comercial",
  descricao: "Como conduzir a venda",
  setor: "Comercial",
  texto: "1. Qualifique o cliente antes de falar de preço.",
};

beforeEach(() => {
  documentos.lista = [];
});

describe("prepararContexto — documentos de apoio", () => {
  it("sem documento vinculado, o prompt é o de sempre, byte a byte", async () => {
    const c = await prepararContexto(agente, RunSource.CHATWOOT);

    expect(c.partes.documentos).toBe("");
    expect(c.systemPrompt).toBe(c.partes.operador + c.partes.conduta + c.partes.colegas);
    expect(c.systemPrompt).not.toContain("DOCUMENTOS DE APOIO");
  });

  it("com documento, ele vem depois do prompt do operador e ANTES das Regras da Casa", async () => {
    documentos.lista = [playbook];
    const { systemPrompt } = await prepararContexto(agente, RunSource.CHATWOOT);

    const fimDoPrompt = systemPrompt.indexOf(agente.systemPrompt) + agente.systemPrompt.length;
    const documentosAqui = systemPrompt.indexOf("--- DOCUMENTOS DE APOIO ---");
    const fim = systemPrompt.indexOf("--- FIM DOS DOCUMENTOS ---");
    const regras = systemPrompt.indexOf("--- REGRAS DA CASA ---");

    expect(documentosAqui).toBeGreaterThanOrEqual(fimDoPrompt);
    expect(fim).toBeGreaterThan(documentosAqui);
    // As regras dizem "as instruções acima": o documento tem de estar acima delas.
    expect(regras).toBeGreaterThan(fim);
    expect(systemPrompt).toContain("1. Qualifique o cliente antes de falar de preço.");
  });

  it("o texto do prompt do operador não é tocado", async () => {
    documentos.lista = [playbook];
    const c = await prepararContexto(agente, RunSource.CHATWOOT);

    expect(c.partes.operador).toBe(agente.systemPrompt);
    expect(c.systemPrompt.startsWith(agente.systemPrompt + "\n\n--- DOCUMENTOS")).toBe(true);
  });

  it("vale em TODA origem — quem avalia a conversa depois também precisa da matriz", async () => {
    documentos.lista = [playbook];

    for (const origem of Object.values(RunSource)) {
      const { systemPrompt } = await prepararContexto(agente, origem);
      expect(systemPrompt, origem).toContain("### Playbook comercial");
    }
  });
});
