import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobConversaEncerrada } from "@/server/queue/conversa-encerrada";

type GatilhoLido = {
  id: string;
  agentId: string;
  agent: { inboxMode: string; inboxIds: number[] };
};

let gatilhos: GatilhoLido[];
let entregasCriadas: { externalId: string; agentId: string; payload: unknown }[];
let externalIdsExistentes: Set<string>;
let jobs: JobConversaEncerrada[];
let bancoFora: boolean;
let consultou: boolean;

vi.mock("@/lib/db", () => ({
  db: {
    gatilhoDeConversa: {
      findMany: async () => {
        consultou = true;
        if (bancoFora) throw new Error("banco fora do ar");
        return gatilhos;
      },
    },
    webhookEvent: {
      create: async ({
        data,
      }: {
        data: { externalId: string; agentId: string; payload: unknown };
      }) => {
        if (externalIdsExistentes.has(data.externalId)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        entregasCriadas.push(data);
        return { id: `entrega-${entregasCriadas.length}` };
      },
    },
  },
}));

vi.mock("@/server/queue/conversa-encerrada", () => ({
  agendarConversaEncerrada: async (dados: JobConversaEncerrada) => {
    jobs.push(dados);
  },
}));

const { dispararGatilhosDeConversa } = await import("./disparar");

const resolucao = (extra: Record<string, unknown> = {}) => ({
  event: "conversation_status_changed",
  id: 13498,
  inbox_id: 29,
  status: "resolved",
  updated_at: 1789485438.5,
  meta: { sender: { name: "Maria", phone_number: "+558487654321" } },
  ...extra,
});

const gatilho = (parcial: Partial<GatilhoLido> = {}): GatilhoLido => ({
  id: "gatilho-1",
  agentId: "avaliador",
  agent: { inboxMode: "all", inboxIds: [] },
  ...parcial,
});

beforeEach(() => {
  gatilhos = [gatilho()];
  entregasCriadas = [];
  externalIdsExistentes = new Set();
  jobs = [];
  bancoFora = false;
  consultou = false;
});

describe("dispararGatilhosDeConversa", () => {
  it("resolução vira uma entrega registrada e um job por gatilho", async () => {
    expect(await dispararGatilhosDeConversa(resolucao())).toBe(1);

    expect(entregasCriadas).toHaveLength(1);
    expect(entregasCriadas[0].externalId).toBe("avaliador:13498:1789485438");
    // Sem nome nem telefone na tabela de entregas, que a equipe inteira lê.
    expect(JSON.stringify(entregasCriadas[0].payload)).not.toContain("Maria");
    expect(JSON.stringify(entregasCriadas[0].payload)).not.toContain("558487654321");

    expect(jobs).toEqual([
      {
        gatilhoId: "gatilho-1",
        agentId: "avaliador",
        webhookEventId: "entrega-1",
        chatwootConversationId: 13498,
        inboxId: 29,
        resolvidaEm: 1789485438,
        contatoNome: "Maria",
        telefone: "+558487654321",
      },
    ]);
  });

  it("evento que não é resolução nem consulta o banco", async () => {
    expect(await dispararGatilhosDeConversa(resolucao({ status: "open" }))).toBe(0);
    expect(
      await dispararGatilhosDeConversa(resolucao({ event: "conversation_updated" })),
    ).toBe(0);
    expect(consultou).toBe(false);
  });

  it("respeita o escopo de caixas do agente", async () => {
    gatilhos = [
      gatilho({ id: "so-recepcao", agentId: "a", agent: { inboxMode: "specific", inboxIds: [34] } }),
      gatilho({ id: "whatsapp", agentId: "b", agent: { inboxMode: "specific", inboxIds: [29, 31] } }),
    ];

    expect(await dispararGatilhosDeConversa(resolucao())).toBe(1);
    expect(jobs.map((j) => j.gatilhoId)).toEqual(["whatsapp"]);
  });

  it("⚠ reentrega da mesma resolução não vira segunda execução", async () => {
    // O Chatwoot reenvia em falha; cada reenvio seria uma avaliação paga.
    externalIdsExistentes.add("avaliador:13498:1789485438");

    expect(await dispararGatilhosDeConversa(resolucao())).toBe(0);
    expect(jobs).toEqual([]);
  });

  it("nunca lança: banco fora não derruba o webhook de conta", async () => {
    bancoFora = true;
    await expect(dispararGatilhosDeConversa(resolucao())).resolves.toBe(0);
  });
});
