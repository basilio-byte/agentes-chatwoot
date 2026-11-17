import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationProvider, PrazoStatus, PrazoTipo, RunSource } from "@/generated/prisma/enums";

/**
 * A ação "resolver" do prazo do cliente (pedido do Régis, 22/09/2026): depois
 * que o Financeiro manda a 2ª via, a conversa é resolvida se o cliente ficar
 * em silêncio — e SÓ nesse caso. Banco e Chatwoot simulados.
 */

const AGORA = Date.parse("2026-09-22T18:00:00Z");

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
let registrado: Record<string, unknown> | null = null;

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
    conversation: { findUnique: async () => ({ agentId: "financeiro", chatwootInboxId: 29 }) },
  },
}));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteDoAgente: async () => ({
    obterConversa: async () => conversa,
    listarMensagens: async () => mensagens,
    obterContato: async () => ({ telefone: "+5584987654321" }),
    enviarMensagem: async (id: number, texto: string, opcoes?: { privado?: boolean }) => {
      chamadas.push(`${opcoes?.privado ? "nota" : "mensagem"}:${id}:${texto}`);
      return { id: 1 };
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

let pesquisaPedida: Record<string, unknown> | null = null;
let pesquisaRecusa: string | null = null;
vi.mock("@/server/nps/automatica", () => ({
  iniciarPesquisaAutomatica: async (args: Record<string, unknown>) => {
    pesquisaPedida = args;
    return pesquisaRecusa ? { iniciada: false, motivo: pesquisaRecusa } : { iniciada: true, pesquisaId: "nps-1" };
  },
}));
vi.mock("./crm", () => ({ passarTarefaDoCrm: async () => ({ tarefas: [], problemas: [] }) }));
vi.mock("@/server/prazos/registrar", () => ({
  registrarPrazo: async (args: Record<string, unknown>) => {
    registrado = args;
    return { venceEm: new Date(AGORA + 30 * 60_000) };
  },
  jaVoltouParaOAgente: async () => false,
}));

const { executarPrazosVencidos } = await import("./executar");
const { prazosIntegration } = await import("@/server/integrations/prazos");

function prazoDeResolver(extra: Record<string, unknown> = {}) {
  return {
    id: "p1",
    tipo: PrazoTipo.CLIENTE,
    status: PrazoStatus.PENDENTE,
    chatwootConversationId: 13222,
    agentId: "financeiro",
    portaAgentId: "porta",
    minutos: 30,
    venceEm: new Date(AGORA - 60_000),
    referenciaMensagemId: 100,
    donoId: null,
    donoNome: null,
    acao: { tipo: "resolver" },
    motivo: "2ª via enviada; o cliente não respondeu",
    ...extra,
  };
}

beforeEach(() => {
  chamadas = [];
  prazos = [];
  conversa = { status: "open", assigneeId: null, assigneeTipo: null, inboxId: 29, contactId: 555 };
  pesquisaPedida = null;
  pesquisaRecusa = null;
  mensagens = [
    { id: 99, message_type: 0, sender: { type: "contact" } },
    { id: 100, message_type: 1, sender: { type: "agent_bot" } },
  ];
  registrado = null;
});

describe("prazo do cliente com acao resolver", () => {
  it("cliente em silêncio: nota interna, conversa resolvida no Chatwoot e no banco, nada ao cliente", async () => {
    prazos = [prazoDeResolver()];

    const rodada = await executarPrazosVencidos(AGORA);

    expect(rodada.executados).toBe(1);
    expect(chamadas[0]).toMatch(/^nota:13222:⏱️ Cliente sem responder há 30 min: conversa resolvida pelo agente/);
    expect(chamadas).toContain("status:13222:resolved");
    expect(chamadas).toContain("banco:resolvida:13222");
    expect(chamadas.some((c) => c.startsWith("mensagem:"))).toBe(false);
    expect(prazos[0]).toMatchObject({ status: PrazoStatus.EXECUTADO, resultado: "conversa resolvida" });
  });

  it("o cliente escreveu depois da 2ª via: NÃO resolve", async () => {
    prazos = [prazoDeResolver()];
    mensagens.push({ id: 101, message_type: 0, sender: { type: "contact" } });

    await executarPrazosVencidos(AGORA);

    expect(chamadas).toEqual([]);
    expect(prazos[0].status).toBe(PrazoStatus.CANCELADO);
  });

  it("uma pessoa assumiu a conversa: NÃO resolve", async () => {
    prazos = [prazoDeResolver()];
    conversa = { ...conversa, assigneeId: 44, assigneeTipo: "User" };

    await executarPrazosVencidos(AGORA);

    expect(chamadas.some((c) => c.startsWith("status:"))).toBe(false);
    expect(prazos[0].status).not.toBe(PrazoStatus.EXECUTADO);
  });

  it("alguém da equipe escreveu (até nota interna): NÃO resolve", async () => {
    prazos = [prazoDeResolver()];
    mensagens.push({ id: 101, message_type: 1, private: true, sender: { type: "user" } });

    await executarPrazosVencidos(AGORA);

    expect(chamadas.some((c) => c.startsWith("status:"))).toBe(false);
  });
});

describe("prazo do cliente com acao pesquisa (fim do atendimento do robô)", () => {
  const prazoDePesquisa = () =>
    prazoDeResolver({ acao: { tipo: "pesquisa" }, motivo: "2ª via enviada; o cliente não respondeu" });

  it("cliente em silêncio: inicia a pesquisa com o agente e a porta, deixa nota e NÃO resolve agora", async () => {
    prazos = [prazoDePesquisa()];

    const rodada = await executarPrazosVencidos(AGORA);

    expect(rodada.executados).toBe(1);
    expect(pesquisaPedida).toMatchObject({
      chatwootConversationId: 13222,
      inboxId: 29,
      portaAgentId: "porta",
      agentId: "financeiro",
      telefone: "+5584987654321",
    });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatch(/^nota:13222:⏱️ Cliente sem responder há 30 min depois de o agente concluir/);
    // Quem resolve é a pesquisa, no fim dela.
    expect(chamadas.some((c) => c.startsWith("status:"))).toBe(false);
    expect(chamadas.some((c) => c.startsWith("mensagem:"))).toBe(false);
    expect(prazos[0]).toMatchObject({
      status: PrazoStatus.EXECUTADO,
      resultado: "pesquisa de satisfação iniciada",
    });
  });

  it("a pesquisa não pode sair: resolve como \"resolver\", com o motivo na nota", async () => {
    prazos = [prazoDePesquisa()];
    pesquisaRecusa = "este telefone já recebeu a pesquisa nas últimas 24 h (conversa #9738)";

    await executarPrazosVencidos(AGORA);

    expect(chamadas[0]).toMatch(/sem pesquisa de satisfação \(este telefone já recebeu/);
    expect(chamadas).toContain("status:13222:resolved");
    expect(chamadas).toContain("banco:resolvida:13222");
    expect(prazos[0]).toMatchObject({ status: PrazoStatus.EXECUTADO });
    expect(String(prazos[0].resultado)).toMatch(/^conversa resolvida sem pesquisa/);
  });

  it("o cliente escreveu antes de vencer: nem pesquisa nem resolve", async () => {
    prazos = [prazoDePesquisa()];
    mensagens.push({ id: 101, message_type: 0, sender: { type: "contact" } });

    await executarPrazosVencidos(AGORA);

    expect(pesquisaPedida).toBeNull();
    expect(chamadas).toEqual([]);
    expect(prazos[0].status).toBe(PrazoStatus.CANCELADO);
  });

  it("uma pessoa assumiu a conversa: nem pesquisa nem resolve", async () => {
    prazos = [prazoDePesquisa()];
    conversa = { ...conversa, assigneeId: 44, assigneeTipo: "User" };

    await executarPrazosVencidos(AGORA);

    expect(pesquisaPedida).toBeNull();
    expect(prazos[0].status).not.toBe(PrazoStatus.EXECUTADO);
  });
});

describe("a ferramenta prazo_resposta_do_cliente", () => {
  const ferramenta = prazosIntegration.tools.find((t) => t.name === "prazo_resposta_do_cliente")!;
  const ctx = {
    provider: IntegrationProvider.PRAZOS,
    config: {},
    credential: null,
    agentId: "financeiro",
    canalAgentId: "porta",
    source: RunSource.CHATWOOT,
    chatwootConversationId: 13222,
  };

  it('"resolver" não precisa de texto, e registra a ação', async () => {
    const r = (await ferramenta.execute(
      ferramenta.inputSchema.parse({ minutos: 30, acao: "resolver", motivo: "2ª via enviada" }),
      ctx,
    )) as Record<string, unknown>;

    expect(r.registrado).toBe(true);
    expect(String(r.observacao)).toContain("a conversa é resolvida");
    expect(registrado).toMatchObject({ tipo: PrazoTipo.CLIENTE, acao: { tipo: "resolver" }, minutos: 30 });
  });

  it('"pesquisa" não precisa de texto, e registra a ação', async () => {
    const r = (await ferramenta.execute(
      ferramenta.inputSchema.parse({ minutos: 10, acao: "pesquisa", motivo: "reserva confirmada" }),
      ctx,
    )) as Record<string, unknown>;

    expect(r.registrado).toBe(true);
    expect(String(r.observacao)).toContain("pesquisa de satisfação");
    expect(registrado).toMatchObject({ tipo: PrazoTipo.CLIENTE, acao: { tipo: "pesquisa" }, minutos: 10 });
  });

  it('"mensagem" sem texto é recusa, e nada é registrado', async () => {
    const r = (await ferramenta.execute(
      ferramenta.inputSchema.parse({ minutos: 30, acao: "mensagem", motivo: "sumiu" }),
      ctx,
    )) as Record<string, unknown>;

    expect(r.registrado).toBe(false);
    expect(registrado).toBeNull();
  });
});
