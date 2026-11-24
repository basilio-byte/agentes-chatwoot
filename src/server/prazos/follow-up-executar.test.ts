import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationProvider, PrazoStatus, PrazoTipo, RunSource } from "@/generated/prisma/enums";

/**
 * O follow-up do lead no vigia (task 17twvjx1037, conversa 15070): cada etapa
 * só age com a conversa ainda do robô e ninguém tendo escrito depois, e cada
 * uma registra a seguinte. Banco, Chatwoot e CRM simulados.
 */

const AGORA = Date.parse("2026-11-24T13:00:00Z");

let chamadas: string[] = [];
let prazos: Array<Record<string, unknown>> = [];
let conversa = {
  status: "open",
  assigneeId: null as number | null,
  assigneeTipo: null as string | null,
  inboxId: 29,
  contactId: 555 as number | null,
};
let mensagens: Array<{ id: number; message_type: number; private?: boolean; sender?: { type?: string } }> = [];
let registrados: Array<Record<string, unknown>> = [];
let perdaPedida: Record<string, unknown> | null = null;
let proximoId = 200;

vi.mock("@/lib/db", () => ({
  db: {
    prazoDeConversa: {
      findMany: async () => prazos.filter((p) => p.status === PrazoStatus.PENDENTE),
      updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        const alvo = prazos.filter((p) => p.id === where.id && p.status === where.status);
        alvo.forEach((p) => Object.assign(p, data));
        return { count: alvo.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const p = prazos.find((x) => x.id === where.id)!;
        Object.assign(p, data);
        return p;
      },
    },
    integration: { findUnique: async () => ({ id: "int-prazos", enabled: true }) },
    agentIntegration: { findFirst: async () => ({ id: "ligada" }) },
    conversation: { findUnique: async () => ({ agentId: "salas-privativas", chatwootInboxId: 29 }) },
    agent: { findUnique: async () => ({ name: "Agente de Salas Privativas" }) },
  },
}));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteDoAgente: async () => ({
    baseUrl: "https://chat.exemplo",
    contaId: 1,
    obterConversa: async () => conversa,
    listarMensagens: async () => mensagens,
    obterContato: async () => ({ nome: "Fulano", telefone: "+5584987654321" }),
    enviarMensagem: async (id: number, texto: string, opcoes?: { privado?: boolean }) => {
      chamadas.push(`${opcoes?.privado ? "nota" : "mensagem"}:${id}:${texto}`);
      return { id: proximoId++ };
    },
    alternarStatus: async (id: number, status: string) => chamadas.push(`status:${id}:${status}`),
    listarAtendentes: async () => [],
  }),
}));

vi.mock("@/server/integrations/chatwoot/resolucao", () => ({
  marcarResolvida: async (id: number) => chamadas.push(`banco:resolvida:${id}`),
  entregarAoHumano: async () => undefined,
  devolverAoAgente: async () => 1,
}));
vi.mock("@/server/queue/atendimento", () => ({ agendarAtendimento: async () => undefined }));
vi.mock("@/server/nps/automatica", () => ({ iniciarPesquisaAutomatica: async () => ({ iniciada: false, motivo: "x" }) }));
vi.mock("./crm", () => ({ passarTarefaDoCrm: async () => ({ tarefas: [], problemas: [] }) }));
let respostaDaPerda: Record<string, unknown> = {
  tarefa: { id: "t1", url: "https://app.clickup.com/t/t1", origem: "conversa" },
  marcada: true,
  observacao: null,
  problemas: [],
};
vi.mock("./perda", () => ({
  perderNoCrm: async (args: Record<string, unknown>) => {
    perdaPedida = args;
    chamadas.push("crm:perdido");
    return respostaDaPerda;
  },
}));
vi.mock("@/server/prazos/registrar", () => ({
  registrarPrazo: async (args: Record<string, unknown>) => {
    registrados.push(args);
    return { venceEm: new Date(AGORA + 30 * 60_000) };
  },
  jaVoltouParaOAgente: async () => false,
}));

const { executarPrazosVencidos } = await import("./executar");
const { prazosIntegration } = await import("@/server/integrations/prazos");

const MENSAGENS = ["Você deseja seguir com a contratação da sala privativa?", "Ainda tem interesse na sala?"];

function prazoDeFollowUp(etapa: 1 | 2 | 3, extra: Record<string, unknown> = {}) {
  return {
    id: `p${etapa}`,
    tipo: PrazoTipo.CLIENTE,
    status: PrazoStatus.PENDENTE,
    chatwootConversationId: 15070,
    agentId: "salas-privativas",
    portaAgentId: "porta",
    minutos: 30,
    venceEm: new Date(AGORA - 60_000),
    referenciaMensagemId: 100,
    donoId: null,
    donoNome: null,
    acao: { tipo: "follow_up", etapa, mensagens: MENSAGENS, produto: "Sala Privativa" },
    motivo: "lead parou de responder as perguntas da sala privativa",
    ...extra,
  };
}

beforeEach(() => {
  chamadas = [];
  prazos = [];
  registrados = [];
  perdaPedida = null;
  proximoId = 200;
  conversa = { status: "open", assigneeId: null, assigneeTipo: null, inboxId: 29, contactId: 555 };
  mensagens = [
    { id: 99, message_type: 0, sender: { type: "contact" } },
    { id: 100, message_type: 1, sender: { type: "agent_bot" } },
  ];
  respostaDaPerda = {
    tarefa: { id: "t1", url: "https://app.clickup.com/t/t1", origem: "conversa" },
    marcada: true,
    observacao: null,
    problemas: [],
  };
});

describe("follow-up: 1ª e 2ª etapa", () => {
  it("1ª etapa: manda a 1ª mensagem, deixa nota e registra a 2ª etapa a partir do que saiu", async () => {
    prazos = [prazoDeFollowUp(1)];

    const rodada = await executarPrazosVencidos(AGORA);

    expect(rodada.executados).toBe(1);
    expect(chamadas[0]).toBe(`mensagem:15070:${MENSAGENS[0]}`);
    expect(chamadas[1]).toMatch(/^nota:15070:⏱️ Follow-up 1 de 3: .*a 2ª mensagem sai em 30 min/);
    expect(registrados).toHaveLength(1);
    expect(registrados[0]).toMatchObject({
      tipo: PrazoTipo.CLIENTE,
      chatwootConversationId: 15070,
      agentId: "salas-privativas",
      portaAgentId: "porta",
      minutos: 30,
      referenciaMensagemId: 200,
      acao: { tipo: "follow_up", etapa: 2, mensagens: MENSAGENS, produto: "Sala Privativa" },
    });
    expect(prazos[0]).toMatchObject({ status: PrazoStatus.EXECUTADO, resultado: "follow-up 1 de 3: mensagem enviada" });
    expect(chamadas.some((c) => c.startsWith("status:"))).toBe(false);
  });

  it("2ª etapa: manda a 2ª mensagem e registra a 3ª", async () => {
    prazos = [prazoDeFollowUp(2)];

    await executarPrazosVencidos(AGORA);

    expect(chamadas[0]).toBe(`mensagem:15070:${MENSAGENS[1]}`);
    expect(chamadas[1]).toMatch(/lead fica como perdido no CRM/);
    expect(registrados[0]).toMatchObject({ acao: { etapa: 3 } });
  });
});

describe("follow-up: 3ª etapa", () => {
  it("dá o lead como perdido no CRM e resolve a conversa, sem nada ao cliente", async () => {
    prazos = [prazoDeFollowUp(3)];

    await executarPrazosVencidos(AGORA);

    expect(perdaPedida).toMatchObject({
      chatwootConversationId: 15070,
      contato: { nome: "Fulano", telefone: "+5584987654321" },
      produto: "Sala Privativa",
      agente: "Agente de Salas Privativas",
      minutos: 30,
      linkDaConversa: "https://chat.exemplo/app/accounts/1/conversations/15070",
    });
    expect(chamadas[0]).toBe("crm:perdido");
    expect(chamadas[1]).toMatch(/^nota:15070:⏱️ Follow-up 3 de 3: o cliente não respondeu/);
    expect(chamadas[1]).toContain('CRM: lead marcado como perdido (motivo "Não respondeu") na task https://app.clickup.com/t/t1.');
    expect(chamadas).toContain("status:15070:resolved");
    expect(chamadas).toContain("banco:resolvida:15070");
    expect(chamadas.some((c) => c.startsWith("mensagem:"))).toBe(false);
    expect(registrados).toHaveLength(0);
    expect(prazos[0]).toMatchObject({
      status: PrazoStatus.EXECUTADO,
      resultado: "follow-up 3 de 3: lead perdido no CRM · conversa resolvida",
    });
  });

  it("CRM que não atualizou não impede encerrar, e o motivo vai na nota", async () => {
    prazos = [prazoDeFollowUp(3)];
    respostaDaPerda = { tarefa: null, marcada: false, observacao: null, problemas: ["CRM não atualizado: a integração do ClickUp está desligada"] };

    await executarPrazosVencidos(AGORA);

    expect(chamadas[1]).toContain("AVISO: CRM não atualizado: a integração do ClickUp está desligada");
    expect(chamadas).toContain("status:15070:resolved");
    expect(String(prazos[0].resultado)).toContain("CRM não atualizado");
  });
});

describe("follow-up: as travas de todo prazo do cliente", () => {
  it("o cliente respondeu: a etapa cai e nada sai", async () => {
    prazos = [prazoDeFollowUp(2)];
    mensagens.push({ id: 101, message_type: 0, sender: { type: "contact" } });

    await executarPrazosVencidos(AGORA);

    expect(chamadas).toEqual([]);
    expect(registrados).toHaveLength(0);
    expect(prazos[0]).toMatchObject({ status: PrazoStatus.CANCELADO, resultado: "o cliente respondeu" });
  });

  it("uma pessoa assumiu a conversa: não manda, não perde no CRM, não resolve", async () => {
    prazos = [prazoDeFollowUp(3)];
    conversa = { ...conversa, assigneeId: 44, assigneeTipo: "User" };

    await executarPrazosVencidos(AGORA);

    expect(perdaPedida).toBeNull();
    expect(chamadas).toEqual([]);
    expect(prazos[0].status).toBe(PrazoStatus.CANCELADO);
  });

  it("alguém da equipe escreveu (até nota interna): nada acontece", async () => {
    prazos = [prazoDeFollowUp(1)];
    mensagens.push({ id: 101, message_type: 1, private: true, sender: { type: "user" } });

    await executarPrazosVencidos(AGORA);

    expect(chamadas).toEqual([]);
    expect(prazos[0].status).toBe(PrazoStatus.CANCELADO);
  });

  it("a conversa foi resolvida por alguém: nada acontece", async () => {
    prazos = [prazoDeFollowUp(1)];
    conversa = { ...conversa, status: "resolved" };

    await executarPrazosVencidos(AGORA);

    expect(chamadas).toEqual([]);
    expect(registrados).toHaveLength(0);
  });
});

describe("a ferramenta prazo_resposta_do_cliente com acao follow_up", () => {
  const ferramenta = prazosIntegration.tools.find((t) => t.name === "prazo_resposta_do_cliente")!;
  const ctx = {
    provider: IntegrationProvider.PRAZOS,
    config: {},
    credential: null,
    agentId: "salas-privativas",
    canalAgentId: "porta",
    source: RunSource.CHATWOOT,
    chatwootConversationId: 15070,
  };
  const chamar = (entrada: Record<string, unknown>) =>
    ferramenta.execute(ferramenta.inputSchema.parse(entrada), ctx) as Promise<Record<string, unknown>>;

  it("registra a 1ª etapa com as duas mensagens e o produto como o CRM escreve", async () => {
    const r = await chamar({
      minutos: 30,
      acao: "follow_up",
      texto: MENSAGENS[0],
      segundoTexto: MENSAGENS[1],
      produto: "sala privativa",
      motivo: "lead parou de responder",
    });

    expect(r.registrado).toBe(true);
    expect(String(r.observacao)).toContain("perdido no CRM");
    expect(registrados[0]).toMatchObject({
      tipo: PrazoTipo.CLIENTE,
      minutos: 30,
      referenciaMensagemId: 100,
      acao: { tipo: "follow_up", etapa: 1, mensagens: MENSAGENS, produto: "Sala Privativa" },
    });
  });

  it("produto que o CRM não conhece vira nulo (a task nasce 'Não definido')", async () => {
    await chamar({
      minutos: 30,
      acao: "follow_up",
      texto: MENSAGENS[0],
      segundoTexto: MENSAGENS[1],
      produto: "coworking",
      motivo: "lead parou de responder",
    });
    expect(registrados[0]).toMatchObject({ acao: { produto: null } });
  });

  it("sem a 2ª mensagem, ou com a mesma mensagem duas vezes, é recusa e nada é registrado", async () => {
    const semSegunda = await chamar({ minutos: 30, acao: "follow_up", texto: MENSAGENS[0], motivo: "sumiu" });
    const repetida = await chamar({
      minutos: 30,
      acao: "follow_up",
      texto: MENSAGENS[0],
      segundoTexto: ` ${MENSAGENS[0]} `,
      motivo: "sumiu",
    });

    expect(semSegunda.registrado).toBe(false);
    expect(repetida.registrado).toBe(false);
    expect(registrados).toHaveLength(0);
  });

  it("com a conversa de uma pessoa, não registra", async () => {
    conversa = { ...conversa, assigneeId: 44, assigneeTipo: "User" };
    const r = await chamar({
      minutos: 30,
      acao: "follow_up",
      texto: MENSAGENS[0],
      segundoTexto: MENSAGENS[1],
      motivo: "sumiu",
    });
    expect(r.registrado).toBe(false);
    expect(registrados).toHaveLength(0);
  });
});
