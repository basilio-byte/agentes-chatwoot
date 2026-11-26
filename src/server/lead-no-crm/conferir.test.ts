import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O registro automático do lead de ponta a ponta, com banco, Chatwoot e runner
 * simulados: o pendente nasce na passagem, e o agente de CRM só roda quando a
 * conversa está com uma pessoa da equipe e sem task.
 */

const AGORA = new Date("2026-11-26T15:00:00Z");
const MIN = 60_000;

type Linha = {
  id: string;
  provider: string;
  externalId: string;
  resultado: string | null;
  detalhe?: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
  processedAt?: Date | null;
};

let configChatwoot: Record<string, unknown>;
let linhas: Linha[];
let aoVivo: {
  status: string;
  assigneeId: number | null;
  assigneeTipo: string | null;
  assigneeNome: string | null;
  contactId: number | null;
  inboxId: number | null;
};
let saidasDeTask: unknown[];
let chamadasDeSuporte: number;
let agenteDaConversa: string | null;
let execucoes: Record<string, unknown>[];
let falhaDoRunner: (Error & { runId?: string }) | null;
let toolsDaExecucaoQueFalhou: number;

const casa = (l: Linha, where: Record<string, unknown>) =>
  Object.entries(where).every(([campo, cond]) => {
    const valor = (l as unknown as Record<string, unknown>)[campo];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { lte?: Date };
      if (c.lte) return (valor as Date) <= c.lte;
    }
    return valor === cond;
  });

const AGENTES = [
  { id: "ag-ev", key: "vendedor-ev", name: "Everton - Vendedor EV" },
  { id: "ag-sup", key: "agente-de-suporte-ao-cliente", name: "Suporte" },
  { id: "ag-crm", key: "agente-crm-comercial", name: "Agente CRM Comercial" },
];

vi.mock("@/lib/db", () => ({
  db: {
    integration: { findUnique: async () => ({ config: configChatwoot }) },
    webhookEvent: {
      create: async ({ data }: { data: Omit<Linha, "id" | "createdAt"> }) => {
        if (linhas.some((l) => l.externalId === data.externalId)) {
          throw Object.assign(new Error("Unique"), { code: "P2002" });
        }
        linhas.push({ ...data, id: `l${linhas.length + 1}`, createdAt: AGORA });
        return {};
      },
      findMany: async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
        linhas.filter((l) => casa(l, where)).slice(0, take),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Linha> }) => {
        const alvo = linhas.filter((l) => casa(l, where));
        alvo.forEach((l) => Object.assign(l, data));
        return { count: alvo.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Linha> }) => {
        const l = linhas.find((x) => x.id === where.id)!;
        Object.assign(l, data);
        return l;
      },
    },
    conversation: {
      findUnique: async () => ({ id: "conv-local", agentId: agenteDaConversa, portaAgentId: "porta" }),
    },
    toolCall: {
      findMany: async () => saidasDeTask.map((output) => ({ output })),
      count: async ({ where }: { where: { toolName?: string; runId?: string } }) =>
        where.runId ? toolsDaExecucaoQueFalhou : chamadasDeSuporte,
    },
    agent: {
      findFirst: async () => ({ id: "ag-crm", name: "Agente CRM Comercial", active: true }),
      findMany: async () => AGENTES,
    },
    gatilhoDeConversa: { findFirst: async () => ({ contasDeAutomacao: ["Basílio Oliveira"] }) },
  },
}));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteDeLeitura: async () => ({
    config: { baseUrl: "https://chatwoot.test", accountId: 1 },
    cliente: {
      obterConversa: async () => aoVivo,
      obterContato: async () => ({ nome: "Cliente Teste", telefone: "+5584999990000" }),
    },
  }),
}));

vi.mock("@/server/conversa-encerrada/leitura", () => ({
  lerAtendimento: async () => ({
    completa: true,
    mensagens: [
      { id: 1, content: "quero endereço fiscal", message_type: 0, created_at: 1795700000, sender: { type: "contact", name: "Cliente Teste" } },
    ],
  }),
}));

vi.mock("@/server/agents/runner", () => ({
  executarAgente: async (args: Record<string, unknown>) => {
    execucoes.push(args);
    if (falhaDoRunner) throw falhaDoRunner;
    return { runId: "run-crm", toolCalls: [{}, {}], iteracoes: 3 };
  },
}));

const { registrarLeadPendente, rodar, conferirLeadsNoCrm, reiniciarRelogioDoLead } = await import(
  "./conferir"
);
const { lerConfigDoLead } = await import("./regras");

/** Um pendente registrado há `minutos`. */
function pendente(minutos: number, conversa = 15480) {
  linhas.push({
    id: `p${linhas.length + 1}`,
    provider: "LEAD_CRM",
    externalId: `conversa:${conversa}:0`,
    resultado: "pendente",
    payload: { conversa, inbox: 29, agente: "vendedor-ev", desde: null },
    createdAt: new Date(AGORA.getTime() - minutos * MIN),
  });
}

const config = () => lerConfigDoLead(configChatwoot);

beforeEach(() => {
  reiniciarRelogioDoLead();
  configChatwoot = { baseUrl: "https://chatwoot.test", leadNoCrm: { modo: "ligado" } };
  linhas = [];
  aoVivo = {
    status: "open",
    assigneeId: 7,
    assigneeTipo: "User",
    assigneeNome: "Alan Novaes",
    contactId: 99,
    inboxId: 29,
  };
  saidasDeTask = [];
  chamadasDeSuporte = 0;
  agenteDaConversa = "ag-ev";
  execucoes = [];
  falhaDoRunner = null;
  toolsDaExecucaoQueFalhou = 0;
});

describe("registrarLeadPendente", () => {
  const passar = (agenteKey = "vendedor-ev") =>
    registrarLeadPendente({
      chatwootConversationId: 15480,
      inboxId: 29,
      agenteKey,
      atendimentoDesde: null,
    });

  it("passagem para agente comercial grava UM pendente, sem nome nem telefone", async () => {
    expect(await passar()).toBe(true);
    expect(await passar()).toBe(false); // o segundo agente do mesmo atendimento
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ provider: "LEAD_CRM", resultado: "pendente" });
    expect(linhas[0].payload).toEqual({ conversa: 15480, inbox: 29, agente: "vendedor-ev", desde: null });
  });

  it("desligado, ou agente fora da lista (Suporte, Financeiro): nada", async () => {
    expect(await passar("agente-de-suporte-ao-cliente")).toBe(false);
    configChatwoot = {};
    expect(await passar()).toBe(false);
    expect(linhas).toHaveLength(0);
  });
});

describe("rodar", () => {
  it("lead com uma pessoa e sem task: aciona o CRM pelo caminho do checkbox", async () => {
    pendente(5);

    const r = await rodar(AGORA, config());

    expect(r).toMatchObject({ registradas: 1, falhas: 0 });
    expect(execucoes).toHaveLength(1);
    expect(execucoes[0]).toMatchObject({
      agentId: "ag-crm",
      source: "CONVERSA_MARCADA",
      conversationId: "conv-local",
      chatwootConversationId: 15480,
      canalAgentId: "porta",
    });
    const mensagem = String(execucoes[0].mensagem);
    expect(mensagem.startsWith("[Checkbox marcado no Chatwoot —")).toBe(true);
    expect(mensagem).toMatch(/Dono da conversa no Chatwoot: Alan Novaes/);
    expect(linhas[0]).toMatchObject({ resultado: "registrada" });
    // O rastro não leva nome nem telefone do cliente.
    expect(linhas[0].detalhe).not.toMatch(/Cliente Teste|99999/);
  });

  it("cedo demais: o pendente de 1 min ainda nem é olhado", async () => {
    pendente(1);
    expect(await rodar(AGORA, config())).toMatchObject({ olhadas: 0 });
    expect(linhas[0].resultado).toBe("pendente");
  });

  it("⚠ com o robô ainda conduzindo: volta para a fila sem chamar o CRM", async () => {
    pendente(5);
    aoVivo = { ...aoVivo, assigneeId: 4, assigneeTipo: "AgentBot", assigneeNome: "Seahub Coworking" };

    const r = await rodar(AGORA, config());

    expect(r).toMatchObject({ esperando: 1, registradas: 0 });
    expect(execucoes).toHaveLength(0);
    expect(linhas[0].resultado).toBe("pendente");
    expect(linhas[0].processedAt).toBeInstanceOf(Date);
  });

  it("a conversa já tem task (de qualquer agente): encerra sem chamar o CRM", async () => {
    pendente(5);
    saidasDeTask = [{ criada: true, id: "86a1" }];

    await rodar(AGORA, config());

    expect(execucoes).toHaveLength(0);
    expect(linhas[0].resultado).toBe("já registrada");
  });

  it("virou suporte, ou está com um agente que não é comercial: não é lead", async () => {
    pendente(5);
    chamadasDeSuporte = 1;
    await rodar(AGORA, config());
    expect(linhas[0].resultado).toBe("suporte");

    linhas = [];
    chamadasDeSuporte = 0;
    agenteDaConversa = "ag-sup";
    pendente(5);
    await rodar(AGORA, config());
    expect(linhas[0].resultado).toBe("não é lead");
    expect(execucoes).toHaveLength(0);
  });

  it("em sombra: anota o que faria e não chama o CRM", async () => {
    pendente(5);
    configChatwoot = { leadNoCrm: { modo: "sombra" } };

    const r = await rodar(AGORA, config());

    expect(r.sombra).toBe(1);
    expect(execucoes).toHaveLength(0);
    expect(linhas[0].resultado).toBe("sombra");
  });

  it("falha do CRM ANTES de qualquer ferramenta volta para a fila; DEPOIS, não repete", async () => {
    pendente(5);
    falhaDoRunner = Object.assign(new Error("OpenRouter fora"), { runId: "r1" });
    await rodar(AGORA, config());
    expect(linhas[0].resultado).toBe("pendente");

    linhas = [];
    pendente(5);
    toolsDaExecucaoQueFalhou = 2;
    await rodar(AGORA, config());
    // A task pode já estar no CRM: de novo seria task em dobro.
    expect(linhas[0].resultado).toBe("falhou");
  });
});

describe("conferirLeadsNoCrm", () => {
  it("desligado: nem olha a fila", async () => {
    configChatwoot = {};
    pendente(5);
    expect(await conferirLeadsNoCrm(AGORA, { forcar: true })).toEqual({ acao: "desligada" });
    expect(linhas[0].resultado).toBe("pendente");
  });
});
