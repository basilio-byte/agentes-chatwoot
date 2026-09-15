import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobConversaMarcada } from "@/server/queue/conversa-marcada";

type GatilhoLido = {
  id: string;
  agentId: string;
  atributos: string[];
  agent: { inboxMode: string; inboxIds: number[] };
};

let gatilhos: GatilhoLido[];
let entregasCriadas: { externalId: string; agentId: string; payload: unknown }[];
let externalIdsExistentes: Set<string>;
let jobs: JobConversaMarcada[];
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

vi.mock("@/server/queue/conversa-marcada", () => ({
  agendarConversaMarcada: async (dados: JobConversaMarcada) => {
    jobs.push(dados);
  },
}));

const { dispararGatilhosDeCheckbox } = await import("./disparar");

const marcacao = (extra: Record<string, unknown> = {}) => ({
  event: "conversation_updated",
  id: 12345,
  inbox_id: 29,
  updated_at: 1789489687.2531722,
  meta: { sender: { name: "Maria", phone_number: "+558487654321" } },
  changed_attributes: [
    {
      custom_attributes: {
        previous_value: { passar_para_crm: null },
        current_value: { passar_para_crm: true },
      },
    },
  ],
  ...extra,
});

const gatilho = (parcial: Partial<GatilhoLido> = {}): GatilhoLido => ({
  id: "gatilho-1",
  agentId: "crm-comercial",
  atributos: ["passar_para_crm"],
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

describe("dispararGatilhosDeCheckbox", () => {
  it("marcação vira uma entrega registrada e um job", async () => {
    expect(await dispararGatilhosDeCheckbox(marcacao())).toBe(1);

    expect(entregasCriadas).toHaveLength(1);
    expect(entregasCriadas[0].externalId).toBe(
      "crm-comercial:12345:passar_para_crm:1789489687253",
    );
    // Sem nome nem telefone na tabela de entregas, que a equipe inteira lê.
    expect(JSON.stringify(entregasCriadas[0].payload)).not.toContain("Maria");
    expect(JSON.stringify(entregasCriadas[0].payload)).not.toContain("558487654321");

    expect(jobs).toEqual([
      {
        gatilhoId: "gatilho-1",
        agentId: "crm-comercial",
        webhookEventId: "entrega-1",
        chatwootConversationId: 12345,
        inboxId: 29,
        atributo: "passar_para_crm",
        marcadoEm: 1789489687.2531722,
        contatoNome: "Maria",
        telefone: "+558487654321",
      },
    ]);
  });

  it("checkbox que o gatilho não escuta não vira job", async () => {
    // O banco filtra por `hasSome`; a conferência aqui é a segunda trava, por
    // checkbox, quando a mesma entrega marca mais de um.
    gatilhos = [gatilho({ atributos: ["atendimento"] })];
    expect(await dispararGatilhosDeCheckbox(marcacao())).toBe(0);
    expect(entregasCriadas).toEqual([]);
  });

  it("desmarcar não consulta o banco", async () => {
    const desmarcando = marcacao({
      changed_attributes: [
        {
          custom_attributes: {
            previous_value: { passar_para_crm: true },
            current_value: { passar_para_crm: null },
          },
        },
      ],
    });
    expect(await dispararGatilhosDeCheckbox(desmarcando)).toBe(0);
    expect(consultou).toBe(false);
  });

  it("respeita o escopo de caixas do agente", async () => {
    gatilhos = [
      gatilho({ id: "so-recepcao", agentId: "a", agent: { inboxMode: "specific", inboxIds: [34] } }),
      gatilho({ id: "whatsapp", agentId: "b", agent: { inboxMode: "specific", inboxIds: [29, 31] } }),
    ];

    expect(await dispararGatilhosDeCheckbox(marcacao())).toBe(1);
    expect(jobs.map((j) => j.gatilhoId)).toEqual(["whatsapp"]);
  });

  it("⚠ reentrega da mesma marcação não vira segunda execução", async () => {
    // O Chatwoot reenvia em falha; cada reenvio seria uma task a mais.
    externalIdsExistentes.add("crm-comercial:12345:passar_para_crm:1789489687253");

    expect(await dispararGatilhosDeCheckbox(marcacao())).toBe(0);
    expect(jobs).toEqual([]);
  });

  it("nunca lança: banco fora não derruba o webhook de conta", async () => {
    bancoFora = true;
    await expect(dispararGatilhosDeCheckbox(marcacao())).resolves.toBe(0);
  });
});
