import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rodada da fase 2b com banco e ClickUp simulados.
 *
 * Os números vêm da Base real de 16/11/2026: três tarefas em `renovação`, duas
 * delas (11/11 e 14/11) passadas dos dois dias.
 */

// Segunda-feira, 10h em São Paulo — dentro do horário comercial.
const AGORA = new Date("2026-11-16T13:00:00Z");
const ENTROU_HA_3_DIAS = Date.UTC(2026, 10, 13, 15);
const ENTROU_ONTEM = Date.UTC(2026, 10, 15, 15);
/** 10/12/2026, meio-dia em São Paulo. */
const DATA_DE_REAJUSTE = Date.UTC(2026, 11, 10, 15);

const CAMPO_DATA = "0231d769-5063-439d-8b03-ad660c6bada5";
const CAMPO_CATEGORIA = "9acf7c8a-c46d-4bc3-90df-07a1540cb196";

type Linha = {
  id: string;
  provider: string;
  externalId: string;
  resultado: string | null;
  detalhe?: string | null;
  createdAt: Date;
};

let config = { moverParaNotificacao: true };
let eventos: Linha[] = [];
let listagem: Array<Record<string, unknown>> = [];
let vivas: Record<string, Record<string, unknown>> = {};
let desde: Record<string, { status: string | null; desde: number | null }> = {};
let escritas: string[] = [];
let comentarios: Array<{ id: string; texto: string }> = [];
let clickupAberto = 0;
let recusarEscrita = false;

vi.mock("@/lib/db", () => ({
  db: {
    webhookEvent: {
      create: async ({ data }: { data: Omit<Linha, "id" | "createdAt"> }) => {
        if (eventos.some((e) => e.provider === data.provider && e.externalId === data.externalId)) {
          throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        }
        const linha = { id: `e${eventos.length + 1}`, createdAt: new Date(), ...data };
        eventos.push(linha);
        return linha;
      },
      findUnique: async ({
        where,
      }: {
        where: { provider_externalId: { provider: string; externalId: string } };
      }) =>
        eventos.find(
          (e) =>
            e.provider === where.provider_externalId.provider &&
            e.externalId === where.provider_externalId.externalId,
        ) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<Linha> }) =>
        Object.assign(eventos.find((e) => e.id === where.id)!, data),
      delete: async ({ where }: { where: { id: string } }) => {
        eventos = eventos.filter((e) => e.id !== where.id);
      },
      upsert: async ({ create }: { create: Omit<Linha, "id" | "createdAt"> }) => {
        const existente = eventos.find(
          (e) => e.provider === create.provider && e.externalId === create.externalId,
        );
        if (existente) return Object.assign(existente, create);
        const linha = { id: `e${eventos.length + 1}`, createdAt: new Date(), ...create };
        eventos.push(linha);
        return linha;
      },
    },
  },
}));

vi.mock("./config", () => ({ configDaRenovacao: async () => config }));

vi.mock("@/server/integrations/clickup/sistema", () => ({
  abrirClickUp: async () => {
    clickupAberto += 1;
    return {
      cliente: {
        listarTarefasDaLista: async () => ({ tasks: listagem }),
        tempoNoStatus: async () => desde,
        obterTarefa: async (id: string) => vivas[id],
        atualizarTarefa: async (id: string, dados: { status?: string }) => {
          if (recusarEscrita) throw new Error("ClickUp respondeu 400");
          escritas.push(`${id}/status=${dados.status}`);
        },
        comentarTarefa: async (id: string, texto: string) => {
          comentarios.push({ id, texto });
          return { id: "c1" };
        },
      },
      config: {},
      executar: async () => undefined,
    };
  },
}));

const { moverParaNotificacao, MOVIDAS_POR_RODADA } = await import("./notificar");

const CATEGORIAS = [
  { id: "cat-endereco", name: "Serviços de endereço", orderindex: 1 },
  { id: "cat-sp", name: "Salas privativas", orderindex: 5 },
];

function tarefa(
  id: string,
  extra: { categoria?: string; reajuste?: number | null; nome?: string; status?: string } = {},
) {
  const campos: Array<Record<string, unknown>> = [
    {
      id: CAMPO_CATEGORIA,
      name: "CATEGORIA DE SERVIÇO",
      type: "drop_down",
      value: extra.categoria ?? "cat-endereco",
      type_config: { options: CATEGORIAS },
    },
  ];
  if (extra.reajuste !== null) {
    campos.push({
      id: CAMPO_DATA,
      name: "DATA DE REAJUSTE",
      type: "date",
      value: String(extra.reajuste ?? DATA_DE_REAJUSTE),
    });
  }
  return {
    id,
    name: extra.nome ?? `(${id}) CLIENTE`,
    status: { status: extra.status ?? "renovação" },
    custom_fields: campos,
  };
}

function com(lista: Array<ReturnType<typeof tarefa>>, entrou = ENTROU_HA_3_DIAS) {
  listagem = lista;
  vivas = Object.fromEntries(lista.map((t) => [t.id, t]));
  desde = Object.fromEntries(lista.map((t) => [t.id, { status: "renovação", desde: entrou }]));
}

beforeEach(() => {
  config = { moverParaNotificacao: true };
  eventos = [];
  escritas = [];
  comentarios = [];
  clickupAberto = 0;
  recusarEscrita = false;
  com([tarefa("t1")]);
});

describe("moverParaNotificacao: o caminho que funciona", () => {
  it("move a tarefa que passou dos dois dias, comenta e fecha a reserva", async () => {
    const r = await moverParaNotificacao({ forcar: true }, AGORA);

    expect(r.acao).toBe("conferido");
    expect(r.movidas).toEqual(["(t1) CLIENTE"]);
    expect(escritas).toEqual(["t1/status=notificação renovação"]);
    expect(comentarios).toHaveLength(1);
    expect(comentarios[0].texto).toContain("e-mail de aviso do reajuste");

    const reserva = eventos.find((e) => e.externalId === `notificar:t1:${ENTROU_HA_3_DIAS}`);
    expect(reserva?.resultado).toBe("movida");
  });

  it("⚠ a mesma entrada no status nunca é notificada duas vezes", async () => {
    await moverParaNotificacao({ forcar: true }, AGORA);
    escritas = [];
    comentarios = [];

    // O ClickUp simulado não muda o status, então a tarefa volta na listagem.
    const r = await moverParaNotificacao({ forcar: true }, AGORA);

    expect(escritas).toEqual([]);
    expect(comentarios).toEqual([]);
    expect(r.movidas).toEqual([]);
  });

  it("o desfecho da rodada fica gravado para o MCP", async () => {
    await moverParaNotificacao({ forcar: true }, AGORA);
    const linha = eventos.find((e) => e.externalId === "notificacao:2026-11-16");
    expect(linha?.resultado).toBe("movido");
    expect(linha?.detalhe).toContain("t1");
  });
});

describe("moverParaNotificacao: quando NÃO move", () => {
  it("⚠ desligada, não abre nem o ClickUp", async () => {
    config = { moverParaNotificacao: false };
    const r = await moverParaNotificacao({ forcar: true }, AGORA);
    expect(r.acao).toBe("desligada");
    expect(clickupAberto).toBe(0);
    expect(escritas).toEqual([]);
  });

  it("ainda não deu o tempo: espera, sem pendência", async () => {
    com([tarefa("t1")], ENTROU_ONTEM);
    const r = await moverParaNotificacao({ forcar: true }, AGORA);
    expect(escritas).toEqual([]);
    expect(r.esperando).toBe(1);
    expect(r.pendentes).toEqual([]);
  });

  it("⚠ sala privativa fica de fora e aparece como pendência com o motivo", async () => {
    com([tarefa("sp", { categoria: "cat-sp" })]);
    const r = await moverParaNotificacao({ forcar: true }, AGORA);
    expect(escritas).toEqual([]);
    expect(r.pendentes?.[0]).toContain("sala privativa");
  });

  it("⚠ sem DATA DE REAJUSTE não manda e-mail ao cliente", async () => {
    com([tarefa("t1", { reajuste: null })]);
    const r = await moverParaNotificacao({ forcar: true }, AGORA);
    expect(escritas).toEqual([]);
    expect(r.pendentes?.[0]).toContain("sem DATA DE REAJUSTE");
  });

  it("⚠ o tempo lido tem de ser do status de AGORA: se a leitura diz outro, fica para a próxima", async () => {
    desde = { t1: { status: "notificação renovação", desde: ENTROU_HA_3_DIAS } };
    const r = await moverParaNotificacao({ forcar: true }, AGORA);
    expect(escritas).toEqual([]);
    expect(r.pendentes?.[0]).toContain("desde quando");
  });

  it("⚠ alguém moveu a tarefa à mão entre a listagem e a troca: nada é escrito e a reserva é desfeita", async () => {
    vivas.t1 = tarefa("t1", { status: "notificação renovação" });
    const r = await moverParaNotificacao({ forcar: true }, AGORA);
    expect(escritas).toEqual([]);
    expect(r.pendentes?.[0]).toContain("já não estava");
    expect(eventos.some((e) => e.externalId.startsWith("notificar:"))).toBe(false);
  });

  it("⚠ escrita recusada pelo ClickUp DESFAZ a reserva: a rodada seguinte tenta de novo", async () => {
    recusarEscrita = true;
    const r = await moverParaNotificacao({ forcar: true }, AGORA);
    expect(r.movidas).toEqual([]);
    expect(r.pendentes?.[0]).toContain("recusou");
    expect(eventos.some((e) => e.externalId.startsWith("notificar:"))).toBe(false);
  });

  it("reserva abandonada (processo que caiu no meio) é refeita", async () => {
    eventos.push({
      id: "velha",
      provider: "RENOVACAO",
      externalId: `notificar:t1:${ENTROU_HA_3_DIAS}`,
      resultado: "reservado",
      createdAt: new Date(AGORA.getTime() - 2 * 60 * 60_000),
    });
    // O relógio do teste é o de agora; a reserva tem duas horas a mais que isso.
    const real = Date.now;
    Date.now = () => AGORA.getTime();
    try {
      const r = await moverParaNotificacao({ forcar: true }, AGORA);
      expect(r.movidas).toEqual(["(t1) CLIENTE"]);
    } finally {
      Date.now = real;
    }
  });

  it("reserva RECENTE de outro processo não é refeita", async () => {
    eventos.push({
      id: "nova",
      provider: "RENOVACAO",
      externalId: `notificar:t1:${ENTROU_HA_3_DIAS}`,
      resultado: "reservado",
      // Um minuto antes do relógio do teste.
      createdAt: new Date(AGORA.getTime() - 60_000),
    });
    const real = Date.now;
    Date.now = () => AGORA.getTime();
    try {
      await moverParaNotificacao({ forcar: true }, AGORA);
      expect(escritas).toEqual([]);
    } finally {
      Date.now = real;
    }
  });
});

describe("moverParaNotificacao: os freios", () => {
  it(`⚠ no máximo ${MOVIDAS_POR_RODADA} por rodada (o token é o mesmo dos agentes)`, async () => {
    com(Array.from({ length: MOVIDAS_POR_RODADA + 3 }, (_, i) => tarefa(`t${i}`)));
    const r = await moverParaNotificacao({ forcar: true }, AGORA);
    expect(r.movidas).toHaveLength(MOVIDAS_POR_RODADA);
  }, 20_000);

  it("fora do horário comercial não roda", async () => {
    // Domingo, 10h em São Paulo, depois de `AGORA` (o freio de 30 min é estado de módulo).
    const r = await moverParaNotificacao({}, new Date("2026-11-22T13:00:00Z"));
    expect(r.acao).toBe("fora do horário");
    expect(clickupAberto).toBe(0);
  });
});
