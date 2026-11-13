import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rodada da fase 2 com banco e ClickUp simulados: o que é escrito na tarefa,
 * quando NADA é escrito, e quando nem se abre o ClickUp.
 *
 * O caso base é o real do cliente 5060 (contrato 10601), medido em 10/11/2026:
 * lote de 23/10 com IPCA 4,58%, Conexa em R$ 1.338,62 e a tarefa parada em
 * R$ 1.280,00.
 */

// Segunda-feira, 10h em São Paulo — dentro do horário comercial.
const AGORA = new Date("2026-11-09T13:00:00Z");

const CAMPO_VALOR = "0dad1007-feb0-437a-9051-87bbac539d4c";
const CAMPO_PCT = "facf3434-9ac9-4276-b81f-fca389a8eeb7";
const CAMPO_LINK = "4f3ca1c7-2933-49d5-b2de-d6e9c8d506bd";

type Linha = {
  id: string;
  provider: string;
  externalId: string;
  resultado: string | null;
  detalhe?: string | null;
};

type Campo = { id: string; value?: unknown };

let retratos: Array<Record<string, unknown>> = [];
let eventos: Linha[] = [];
let tarefasDaLista: Array<Record<string, unknown>> = [];
let tarefas: Record<string, Record<string, unknown>> = {};
let escritas: string[] = [];
let comentarios: string[] = [];
let clickupAberto = 0;
let recusarEscrita = false;

vi.mock("@/lib/db", () => ({
  db: {
    retratoDeRenovacao: { findMany: async () => retratos },
    webhookEvent: {
      findMany: async ({ where }: { where: { externalId: { in?: string[]; startsWith?: string } } }) =>
        eventos.filter((e) =>
          where.externalId.in
            ? where.externalId.in.includes(e.externalId)
            : e.externalId.startsWith(where.externalId.startsWith ?? ""),
        ),
      create: async ({ data }: { data: Omit<Linha, "id"> }) => {
        if (eventos.some((e) => e.provider === data.provider && e.externalId === data.externalId)) {
          throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        }
        const linha = { id: `e${eventos.length + 1}`, ...data };
        eventos.push(linha);
        return linha;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Linha> }) => {
        const linha = eventos.find((e) => e.id === where.id)!;
        Object.assign(linha, data);
        return linha;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        eventos = eventos.filter((e) => e.id !== where.id);
      },
      upsert: async ({ create }: { create: Omit<Linha, "id"> }) => {
        const existente = eventos.find(
          (e) => e.provider === create.provider && e.externalId === create.externalId,
        );
        if (existente) return Object.assign(existente, create);
        const linha = { id: `e${eventos.length + 1}`, ...create };
        eventos.push(linha);
        return linha;
      },
    },
  },
}));

vi.mock("@/server/integrations/clickup/sistema", () => ({
  abrirClickUp: async () => {
    clickupAberto += 1;
    return {
      cliente: {
        listarTarefasDaLista: async () => ({ tasks: tarefasDaLista }),
        obterTarefa: async (id: string) => tarefas[id],
        definirCampoPersonalizado: async (id: string, campo: string, valor: unknown) => {
          if (recusarEscrita) throw new Error("ClickUp respondeu 400");
          escritas.push(`${id}/${campo}=${valor}`);
        },
        atualizarTarefa: async (id: string, dados: { status?: string }) => {
          if (recusarEscrita) throw new Error("ClickUp respondeu 400");
          escritas.push(`${id}/status=${dados.status}`);
        },
        comentarTarefa: async (id: string, texto: string) => {
          comentarios.push(texto);
          return { id: "c1" };
        },
      },
      config: {},
      executar: async () => undefined,
    };
  },
}));

const { propagarReajustes } = await import("./propagar");

/** O retrato do 5060 como a rodada do retrato o deixa depois do lote. */
function retrato(extra: Record<string, unknown> = {}) {
  return {
    contratoId: 10601,
    clienteId: 5060,
    leva: "2026-11",
    valorCentavos: 128000,
    valorAtualCentavos: 133862,
    reajusteDoRetrato: null,
    reajusteEm: "2026-10-23",
    reajustePct: 4.58,
    reajusteIndice: "IPCA",
    periodicidade: "Yearly",
    ...extra,
  };
}

function tarefa(extra: { status?: string; campos?: Campo[]; id?: string; nome?: string } = {}) {
  const id = extra.id ?? "86adm4t1k";
  return {
    id,
    name: extra.nome ?? "(5060) 62.622.344 CARLA ADRIANA DE LIMA BARBOSA SABINO",
    status: { status: extra.status ?? "notificação renovação" },
    custom_fields: extra.campos ?? [
      { id: CAMPO_VALOR, value: "1280" },
      { id: CAMPO_LINK, value: "https://seahubcoworking.conexa.app/index.php?r=x&idCliente=5060" },
    ],
  };
}

beforeEach(() => {
  retratos = [retrato()];
  eventos = [];
  const t = tarefa();
  tarefasDaLista = [t];
  tarefas = { [t.id]: t };
  escritas = [];
  comentarios = [];
  clickupAberto = 0;
  recusarEscrita = false;
});

describe("propagarReajustes: o caminho que funciona", () => {
  it("escreve valor, percentual e status, e comenta uma vez", async () => {
    const rodada = await propagarReajustes({ forcar: true }, AGORA);

    expect(rodada.acao).toBe("propagado");
    expect(rodada.candidatos).toBe(1);
    expect(rodada.propagados).toBe(1);
    expect(escritas).toEqual([
      `86adm4t1k/${CAMPO_VALOR}=1338.62`,
      `86adm4t1k/${CAMPO_PCT}=4.58`,
      "86adm4t1k/status=pg pendente - renovação",
    ]);
    expect(comentarios).toHaveLength(1);
    expect(comentarios[0]).toContain("IPCA 4.58%");
  });

  it("a reserva fecha como propagado, com a chave do contrato e do reajuste", async () => {
    await propagarReajustes({ forcar: true }, AGORA);

    const reserva = eventos.find((e) => e.externalId === "reajuste:10601:2026-10-23");
    expect(reserva?.resultado).toBe("propagado");
  });

  it("⚠ rodar de novo não escreve de novo", async () => {
    await propagarReajustes({ forcar: true }, AGORA);
    escritas = [];
    comentarios = [];

    const segunda = await propagarReajustes({ forcar: true }, AGORA);

    expect(segunda.acao).toBe("nada a propagar");
    expect(escritas).toEqual([]);
    expect(comentarios).toEqual([]);
  });
});

describe("propagarReajustes: quando não escreve", () => {
  it("sem candidato, NÃO abre o ClickUp", async () => {
    retratos = [retrato({ reajusteDoRetrato: "2026-10-23" })]; // retrato tirado depois do lote
    const rodada = await propagarReajustes({ forcar: true }, AGORA);
    expect(rodada.acao).toBe("nada a propagar");
    expect(clickupAberto).toBe(0);
  });

  it("reajuste velho sai da fila pela janela de 45 dias", async () => {
    retratos = [retrato({ reajusteEm: "2025-11-19" })];
    const rodada = await propagarReajustes({ forcar: true }, AGORA);
    expect(rodada.acao).toBe("nada a propagar");
  });

  it("⚠⚠ tarefa em `renovação`: escreve os campos e NÃO avança o status", async () => {
    const t = tarefa({ status: "renovação" });
    tarefasDaLista = [t];
    tarefas = { [t.id]: t };

    await propagarReajustes({ forcar: true }, AGORA);

    expect(escritas).not.toContain("86adm4t1k/status=pg pendente - renovação");
    expect(escritas).toHaveLength(2);
    // O comentário diz por que o status ficou onde estava.
    expect(comentarios[0]).toContain("Status não alterado");
    expect(comentarios[0]).toContain("e-mail de notificação");
  });

  it("valor negociado por alguém não é sobrescrito, e o comentário diz os três números", async () => {
    const t = tarefa({
      campos: [
        { id: CAMPO_VALOR, value: "1500" },
        { id: CAMPO_LINK, value: "https://x/?idCliente=5060" },
      ],
    });
    tarefasDaLista = [t];
    tarefas = { [t.id]: t };

    await propagarReajustes({ forcar: true }, AGORA);

    expect(escritas.some((e) => e.includes(CAMPO_VALOR))).toBe(false);
    expect(comentarios[0]).toContain("Valor do contrato não atualizado");
    expect(comentarios[0]).toContain("negociou fora do reajuste");
  });

  it("já estava em dia: reserva fechada, nenhuma escrita e nenhum comentário", async () => {
    const t = tarefa({
      status: "pg pendente - renovação",
      campos: [
        { id: CAMPO_VALOR, value: "1338.62" },
        { id: CAMPO_PCT, value: "4.58" },
      ],
    });
    tarefasDaLista = [t];
    tarefas = { [t.id]: t };

    const rodada = await propagarReajustes({ forcar: true }, AGORA);

    expect(escritas).toEqual([]);
    expect(comentarios).toEqual([]);
    expect(rodada.propagados).toBe(0);
    expect(eventos.find((e) => e.externalId === "reajuste:10601:2026-10-23")?.resultado).toBe(
      "já estava em dia",
    );
  });

  it("⚠ UM contrato e DUAS tarefas iguais: não há como saber qual é a dele — nada é escrito e o motivo fica registrado", async () => {
    const a = tarefa({ id: "t1" });
    const b = tarefa({ id: "t2" });
    tarefasDaLista = [a, b];
    tarefas = { t1: a, t2: b };

    const rodada = await propagarReajustes({ forcar: true }, AGORA);

    expect(escritas).toEqual([]);
    expect(rodada.pendentes?.[0]).toContain("2 tarefas");
    expect(rodada.pendentes?.[0]).toContain("não há como saber");
    // Sem reserva: quando a equipe indicar qual é, a rodada tenta de novo.
    expect(eventos.some((e) => e.externalId.startsWith("reajuste:"))).toBe(false);
  });

  it("⚠ CONEXA LINK apontando para outro cliente barra a escrita", async () => {
    const t = tarefa({
      campos: [
        { id: CAMPO_VALOR, value: "1280" },
        { id: CAMPO_LINK, value: "https://x/?idCliente=1858" },
      ],
    });
    tarefasDaLista = [t];
    tarefas = { [t.id]: t };

    const rodada = await propagarReajustes({ forcar: true }, AGORA);

    expect(escritas).toEqual([]);
    expect(rodada.desfechos?.[0].problemas[0]).toContain("1858");
  });

  it("sem tarefa nos status do fluxo, fica pendente em vez de virar reserva", async () => {
    tarefasDaLista = [];
    tarefas = {};

    const rodada = await propagarReajustes({ forcar: true }, AGORA);

    expect(rodada.pendentes?.[0]).toContain("sem tarefa");
    expect(eventos.some((e) => e.externalId.startsWith("reajuste:"))).toBe(false);
  });

  it("⚠ escrita recusada pelo ClickUp DESFAZ a reserva: a rodada seguinte tenta de novo", async () => {
    recusarEscrita = true;

    const rodada = await propagarReajustes({ forcar: true }, AGORA);

    expect(rodada.desfechos?.[0].problemas.length).toBeGreaterThan(0);
    expect(eventos.some((e) => e.externalId === "reajuste:10601:2026-10-23")).toBe(false);
  });
});

/**
 * Cada tarefa é o contrato de UM produto (Duda, 13/11/2026): cliente com
 * várias tarefas tem vários contratos, e TODOS são reajustados — cada um na
 * tarefa que é a dele. Os números são os reais do (5051) e do (1858).
 */
describe("propagarReajustes: um cliente com vários contratos", () => {
  const LINK_5051 = "https://seahubcoworking.conexa.app/index.php?r=x&idCliente=5051";

  /** Contrato do 5051 depois do lote: R$ 99,90 → R$ 104,48 (IPCA 4,58%). */
  const contrato5051 = (contratoId: number, extra: Record<string, unknown> = {}) =>
    retrato({
      contratoId,
      clienteId: 5051,
      valorCentavos: 9990,
      valorAtualCentavos: 10448,
      reajustePct: 4.58,
      fidelidade: "2026-11-27",
      ...extra,
    });

  const tarefa5051 = (id: string, extra: { status?: string; valor?: string } = {}) =>
    tarefa({
      id,
      nome: "(5051) PAULO HENRIQUE MACIEL BARROSO",
      status: extra.status,
      campos: [
        { id: CAMPO_VALOR, value: extra.valor ?? "99.9" },
        { id: CAMPO_LINK, value: LINK_5051 },
        // 27/11/2026, como o ClickUp devolve a data.
        { id: "0231d769-5063-439d-8b03-ad660c6bada5", value: "1795762800000" },
      ],
    });

  function com(lista: Array<ReturnType<typeof tarefa>>) {
    tarefasDaLista = lista;
    tarefas = Object.fromEntries(lista.map((t) => [t.id, t]));
  }

  it("⚠ (5051) quatro contratos iguais e quatro tarefas iguais: as QUATRO são escritas, uma em cada tarefa", async () => {
    retratos = [10574, 10576, 10578, 10580].map((id) => contrato5051(id));
    com(["t1", "t2", "t3", "t4"].map((id) => tarefa5051(id)));

    const rodada = await propagarReajustes({ forcar: true }, AGORA);

    expect(rodada.propagados).toBe(4);
    expect(rodada.pendentes).toEqual([]);
    for (const id of ["t1", "t2", "t3", "t4"]) {
      expect(escritas).toContain(`${id}/${CAMPO_VALOR}=104.48`);
      expect(escritas).toContain(`${id}/status=pg pendente - renovação`);
    }
    // Uma reserva por contrato, e cada tarefa recebeu UM comentário.
    expect(eventos.filter((e) => e.externalId.startsWith("reajuste:"))).toHaveLength(4);
    expect(comentarios).toHaveLength(4);
  });

  it("⚠ rodar de novo depois do lote inteiro não escreve de novo", async () => {
    retratos = [10574, 10576].map((id) => contrato5051(id));
    com(["t1", "t2"].map((id) => tarefa5051(id)));
    await propagarReajustes({ forcar: true }, AGORA);
    escritas = [];
    comentarios = [];

    const segunda = await propagarReajustes({ forcar: true }, AGORA);

    expect(segunda.acao).toBe("nada a propagar");
    expect(escritas).toEqual([]);
  });

  it("⚠ lote propagado em PARTE: o contrato que falta casa com a tarefa que falta, não com uma já escrita", async () => {
    // Os contratos 1 e 2 já foram propagados (nas tarefas t1 e t2, hoje com o
    // valor novo). Faltam os contratos 3 e 4, e as tarefas t3 e t4.
    retratos = [1, 2, 3, 4].map((id) => contrato5051(id));
    const feito = (contratoId: number, tarefaId: string): Linha => ({
      id: `p${contratoId}`,
      provider: "RENOVACAO",
      externalId: `reajuste:${contratoId}:2026-10-23`,
      resultado: "propagado",
      detalhe: JSON.stringify({ contratoId, clienteId: 5051, tarefaId, problemas: [] }),
    });
    eventos = [feito(1, "t1"), feito(2, "t2")];
    com([
      tarefa5051("t1", { status: "pg pendente - renovação", valor: "104.48" }),
      tarefa5051("t2", { status: "pg pendente - renovação", valor: "104.48" }),
      tarefa5051("t3"),
      tarefa5051("t4"),
    ]);

    const rodada = await propagarReajustes({ forcar: true }, AGORA);

    expect(rodada.propagados).toBe(2);
    expect(escritas.some((e) => e.startsWith("t1/") || e.startsWith("t2/"))).toBe(false);
    expect(escritas).toContain(`t3/${CAMPO_VALOR}=104.48`);
    expect(escritas).toContain(`t4/${CAMPO_VALOR}=104.48`);
  });

  it("⚠ (1858) produtos diferentes do mesmo cliente: cada contrato vai para a tarefa do SEU valor", async () => {
    const link = "https://seahubcoworking.conexa.app/index.php?r=x&idCliente=1858";
    retratos = [
      retrato({
        contratoId: 10441,
        clienteId: 1858,
        valorCentavos: 8900,
        valorAtualCentavos: 9308,
        reajustePct: 4.58,
        fidelidade: "2026-11-06",
      }),
      retrato({
        contratoId: 10378,
        clienteId: 1858,
        valorCentavos: 580000,
        valorAtualCentavos: 606564,
        reajustePct: 4.58,
        fidelidade: "2026-11-04",
      }),
    ];
    const emTarefa = (id: string, valor: string, data: string) =>
      tarefa({
        id,
        nome: "(1858) WENDRILL CASSOL SOCIEDADE INDIVIDUAL DE ADVOCACIA",
        campos: [
          { id: CAMPO_VALOR, value: valor },
          { id: CAMPO_LINK, value: link },
          { id: "0231d769-5063-439d-8b03-ad660c6bada5", value: data },
        ],
      });
    // 06/11/2026 e 04/11/2026.
    com([emTarefa("ev", "89", "1793948400000"), emTarefa("sp", "5800", "1793775600000")]);

    const rodada = await propagarReajustes({ forcar: true }, AGORA);

    expect(rodada.pendentes).toEqual([]);
    expect(escritas).toContain(`ev/${CAMPO_VALOR}=93.08`);
    expect(escritas).toContain(`sp/${CAMPO_VALOR}=6065.64`);
    // E o EV nunca recebe o valor da sala privativa, nem o contrário.
    expect(escritas).not.toContain(`ev/${CAMPO_VALOR}=6065.64`);
    expect(escritas).not.toContain(`sp/${CAMPO_VALOR}=93.08`);
  });

  it("⚠ contrato SEM tarefa que o case e outro com tarefa: só o segundo é escrito, e o primeiro fica pendente com o motivo", async () => {
    retratos = [
      contrato5051(1),
      contrato5051(2, { valorCentavos: 580000, valorAtualCentavos: 606564 }),
    ];
    // Só existe a tarefa do contrato de R$ 99,90.
    com([tarefa5051("t1")]);

    const rodada = await propagarReajustes({ forcar: true }, AGORA);

    expect(rodada.propagados).toBe(1);
    expect(escritas).toContain(`t1/${CAMPO_VALOR}=104.48`);
    expect(rodada.pendentes?.[0]).toContain("contrato 2");
    // O pendente não vira reserva: quando a tarefa aparecer, a rodada tenta de novo.
    expect(eventos.some((e) => e.externalId === "reajuste:2:2026-10-23")).toBe(false);
  });
});

describe("propagarReajustes: os freios", () => {
  it("fora do horário comercial não roda", async () => {
    // Domingo, 10h em São Paulo. ⚠ É o domingo DEPOIS de `AGORA`, de propósito:
    // `ultimaConferencia` é estado de módulo e sobrevive entre os casos, então
    // uma data anterior bateria no freio de 30 min antes de chegar ao horário.
    const rodada = await propagarReajustes({}, new Date("2026-11-15T13:00:00Z"));
    expect(rodada.acao).toBe("fora do horário");
    expect(clickupAberto).toBe(0);
  });

  it("o desfecho da rodada fica gravado para o MCP", async () => {
    await propagarReajustes({ forcar: true }, AGORA);
    const linha = eventos.find((e) => e.externalId === "propagacao:2026-11-09");
    expect(linha?.resultado).toBe("propagado");
    expect(linha?.detalhe).toContain("10601");
  });
});
