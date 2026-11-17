import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A pesquisa no fim de um atendimento feito só pelo robô (pedido do Régis em
 * 17/11/2026, conversa 10954): o prazo do agente vence e a MESMA pesquisa do
 * checkbox é gravada para o executor do NPS mandar. Banco e fila simulados.
 */

const AGORA = Date.parse("2026-11-17T14:00:00Z");
const HORA = 3_600_000;

let integracao: { enabled: boolean; config: unknown } | null;
let emAndamento: { id: string } | null;
let recente: { chatwootConversationId: number } | null;
let criadas: Record<string, unknown>[];
let agendadas: { id: string; espera: number }[];
let consultas: Record<string, unknown>[];
let falharCriacao: boolean;

vi.mock("@/lib/db", () => ({
  db: {
    integration: { findUnique: async () => integracao },
    pesquisaNps: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        consultas.push(where);
        return "telefone" in where ? recente : emAndamento;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (falharCriacao) throw new Error("banco fora do ar");
        criadas.push(data);
        return { id: `nps-${criadas.length}` };
      },
    },
  },
}));

vi.mock("@/server/queue/nps", () => ({
  agendarPesquisaNps: async (id: string, espera = 0) => {
    agendadas.push({ id, espera });
  },
}));

const { iniciarPesquisaAutomatica } = await import("./automatica");

const pedido = (sobre: Record<string, unknown> = {}) => ({
  chatwootConversationId: 10954,
  inboxId: 29,
  portaAgentId: "porta-29",
  agentId: "agente-financeiro",
  telefone: "+55 84 8765-4321",
  agora: AGORA,
  ...sobre,
});

beforeEach(() => {
  integracao = { enabled: true, config: {} };
  emAndamento = null;
  recente = null;
  criadas = [];
  agendadas = [];
  consultas = [];
  falharCriacao = false;
});

describe("iniciarPesquisaAutomatica", () => {
  it("grava a pesquisa AGENDADA com o agente, o telefone canônico e a espera do checkbox", async () => {
    const r = await iniciarPesquisaAutomatica(pedido());

    expect(r).toEqual({ iniciada: true, pesquisaId: "nps-1" });
    expect(criadas).toHaveLength(1);
    expect(criadas[0]).toMatchObject({
      chatwootConversationId: 10954,
      inboxId: 29,
      portaAgentId: "porta-29",
      agentId: "agente-financeiro",
      // Com o nono dígito: "o mesmo telefone" compara pela forma canônica.
      telefone: "84987654321",
    });
    expect((criadas[0].marcadaEm as Date).getTime()).toBe(AGORA);
    expect((criadas[0].venceEm as Date).getTime()).toBe(AGORA + 3_000);
    expect(agendadas).toEqual([{ id: "nps-1", espera: 3_000 }]);
  });

  it("o intervalo por telefone conta da última pesquisa ENVIADA", async () => {
    await iniciarPesquisaAutomatica(pedido());
    const doTelefone = consultas.find((c) => "telefone" in c) as {
      enviadaEm: { gte: Date };
    };
    expect(doTelefone.enviadaEm.gte.getTime()).toBe(AGORA - 24 * HORA);
  });

  it("telefone que já respondeu dentro do intervalo: não grava e diz por quê", async () => {
    recente = { chatwootConversationId: 9738 };
    const r = await iniciarPesquisaAutomatica(pedido());

    expect(r).toEqual({
      iniciada: false,
      motivo: "este telefone já recebeu a pesquisa nas últimas 24 h (conversa #9738)",
    });
    expect(criadas).toEqual([]);
  });

  it("NPS desligado, chave da tela desligada ou caixa de fora: não grava", async () => {
    integracao = { enabled: false, config: {} };
    expect((await iniciarPesquisaAutomatica(pedido())).iniciada).toBe(false);

    integracao = { enabled: true, config: { automatica: false } };
    expect((await iniciarPesquisaAutomatica(pedido())).iniciada).toBe(false);

    integracao = { enabled: true, config: {} };
    expect((await iniciarPesquisaAutomatica(pedido({ inboxId: 31 }))).iniciada).toBe(false);

    expect(criadas).toEqual([]);
  });

  it("pesquisa já andando nesta conversa: não grava outra", async () => {
    emAndamento = { id: "outra" };
    const r = await iniciarPesquisaAutomatica(pedido());
    expect(r).toMatchObject({ iniciada: false, motivo: expect.stringMatching(/em andamento/) });
  });

  it("sem telefone, grava assim mesmo: o executor lê do contato na hora de mandar", async () => {
    const r = await iniciarPesquisaAutomatica(pedido({ telefone: null }));
    expect(r.iniciada).toBe(true);
    expect(criadas[0].telefone).toBeNull();
    expect(consultas.some((c) => "telefone" in c)).toBe(false);
  });

  it("nunca lança: falha do banco vira motivo, e quem chama resolve a conversa", async () => {
    falharCriacao = true;
    const r = await iniciarPesquisaAutomatica(pedido());
    expect(r).toMatchObject({ iniciada: false, motivo: expect.stringMatching(/banco fora do ar/) });
  });
});
