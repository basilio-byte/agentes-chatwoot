import { beforeEach, describe, expect, it, vi } from "vitest";

const AGORA = 1_789_500_000_000;
const MARCADO_EM = 1_789_489_687.25;

let integracao: { enabled: boolean; config: unknown } | null;
let criadas: Record<string, unknown>[];
let erroAoCriar: Error | null;
let agendados: { id: string; espera: number }[];
let filaFora: boolean;

vi.mock("@/lib/db", () => ({
  db: {
    integration: { findUnique: async () => integracao },
    pesquisaNps: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (erroAoCriar) throw erroAoCriar;
        criadas.push(data);
        return { id: `p${criadas.length}` };
      },
    },
  },
}));

vi.mock("@/server/queue/nps", () => ({
  agendarPesquisaNps: async (id: string, espera = 0) => {
    if (filaFora) throw new Error("Redis fora do ar");
    agendados.push({ id, espera });
  },
}));

const { dispararPesquisaNps, ESPERA_DO_ENVIO_MS } = await import("./disparar");

const marcacao = (atributo = "nps_perdido", inbox = 29) => ({
  event: "conversation_updated",
  id: 12345,
  inbox_id: inbox,
  updated_at: MARCADO_EM,
  meta: { sender: { name: "Maria", phone_number: "+558487654321" } },
  changed_attributes: [
    {
      custom_attributes: {
        previous_value: { [atributo]: null },
        current_value: { [atributo]: true },
      },
    },
  ],
});

beforeEach(() => {
  integracao = { enabled: true, config: {} };
  criadas = [];
  erroAoCriar = null;
  agendados = [];
  filaFora = false;
});

describe("dispararPesquisaNps", () => {
  it("grava a pesquisa com o instante da marcação e o telefone canônico, e enfileira", async () => {
    expect(await dispararPesquisaNps(marcacao(), AGORA)).toBe(true);

    expect(criadas).toEqual([
      {
        chatwootConversationId: 12345,
        inboxId: 29,
        // O WhatsApp entregou sem o nono dígito.
        telefone: "84987654321",
        marcadaEm: new Date(Math.round(MARCADO_EM * 1000)),
        venceEm: new Date(AGORA + ESPERA_DO_ENVIO_MS),
      },
    ]);
    expect(agendados).toEqual([{ id: "p1", espera: ESPERA_DO_ENVIO_MS }]);
  });

  it("desligada não faz nada — o NPS do n8n segue com o checkbox", async () => {
    integracao = { enabled: false, config: {} };
    expect(await dispararPesquisaNps(marcacao(), AGORA)).toBe(false);
    expect(criadas).toEqual([]);
  });

  it("outro checkbox ou outra caixa não fazem nada", async () => {
    expect(await dispararPesquisaNps(marcacao("passar_para_crm"), AGORA)).toBe(false);
    expect(await dispararPesquisaNps(marcacao("nps_perdido", 5), AGORA)).toBe(false);
    expect(criadas).toEqual([]);
  });

  it("usa o checkbox e as caixas configurados", async () => {
    integracao = { enabled: true, config: { checkbox: "pesquisa_nps", caixas: [31] } };
    expect(await dispararPesquisaNps(marcacao("nps_perdido", 29), AGORA)).toBe(false);
    expect(await dispararPesquisaNps(marcacao("pesquisa_nps", 31), AGORA)).toBe(true);
  });

  it("reentrega do Chatwoot é barrada pela unique e não enfileira", async () => {
    erroAoCriar = Object.assign(new Error("Unique constraint"), { code: "P2002" });
    expect(await dispararPesquisaNps(marcacao(), AGORA)).toBe(false);
    expect(agendados).toEqual([]);
  });

  it("nunca lança: falha no banco não derruba a rota", async () => {
    erroAoCriar = new Error("conexão perdida");
    await expect(dispararPesquisaNps(marcacao(), AGORA)).resolves.toBe(false);
  });

  it("sem fila, a pesquisa fica gravada para o vigia", async () => {
    filaFora = true;
    expect(await dispararPesquisaNps(marcacao(), AGORA)).toBe(true);
    expect(criadas).toHaveLength(1);
  });
});
