import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rodada da fase 4 com banco, ClickUp e Conexa simulados.
 *
 * O caso base é o `(2129)` real: contrato 3682 de R$ 88,98, cobrança 31571 com
 * as vendas 88552 (do contrato) e 89662 (outra), paga no vencimento.
 */

const REAJUSTE = "2026-11-23";
const HORA = 60 * 60_000;
let relogio = Date.UTC(2026, 11, 16, 13);
/** Cada teste ganha um "agora" 4 h depois do anterior: o rodízio só revisita depois de 3 h. */
const proximoAgora = () => new Date((relogio += 4 * HORA));

type Linha = {
  id: string;
  provider: string;
  externalId: string;
  resultado: string | null;
  detalhe?: string | null;
};

let config = { fecharNoPagamento: true };
let eventos: Linha[] = [];
let retratos: Array<{ contratoId: number; clienteId: number }> = [];
let listagem: Array<Record<string, unknown>> = [];
let vivas: Record<string, Record<string, unknown>> = {};
let escritas: string[] = [];
let comentarios: string[] = [];
let aberturas = { clickup: 0, conexa: 0 };
let devolver = false;
let contratoDoConexa: Record<string, unknown> = {};
let cobrancas: Array<Record<string, unknown>> = [];
let vendasDoConexa: Record<number, Record<string, unknown>> = {};
let idasAoConexa = 0;

vi.mock("@/lib/db", () => ({
  db: {
    retratoDeRenovacao: { findMany: async () => retratos },
    webhookEvent: {
      findMany: async ({
        where,
      }: {
        where: { externalId: { startsWith?: string; in?: string[] } };
      }) =>
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
      update: async ({ where, data }: { where: { id: string }; data: Partial<Linha> }) =>
        Object.assign(eventos.find((e) => e.id === where.id)!, data),
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

vi.mock("./config", () => ({ configDaRenovacao: async () => config }));

vi.mock("@/server/integrations/clickup/sistema", () => ({
  abrirClickUp: async () => {
    aberturas.clickup += 1;
    return {
      cliente: {
        listarTarefasDaLista: async () => ({ tasks: listagem }),
        obterTarefa: async (id: string) => vivas[id],
        atualizarTarefa: async (id: string, d: { status?: string }) => {
          escritas.push(`${id}/status=${d.status}`);
          // A trava da lista devolve a tarefa: o status simplesmente não muda.
          if (!devolver) vivas[id] = { ...vivas[id], status: { status: d.status } };
        },
        comentarTarefa: async (_id: string, texto: string) => {
          comentarios.push(texto);
          return { id: "c" };
        },
      },
      config: {},
      executar: async () => undefined,
    };
  },
}));

vi.mock("@/server/integrations/conexa/sistema", () => ({
  abrirConexa: async () => {
    aberturas.conexa += 1;
    return {
      cliente: {
        obterContrato: async () => {
          idasAoConexa++;
          return contratoDoConexa;
        },
        listarCobrancas: async () => {
          idasAoConexa++;
          return { itens: cobrancas, temMais: false };
        },
        obterVenda: async (id: number) => {
          idasAoConexa++;
          return vendasDoConexa[id] ?? {};
        },
      },
      config: {},
      executar: async () => undefined,
    };
  },
}));

const { fecharCiclosPagos, ajustes, candidatosDoFechamento } = await import("./fechar");
ajustes.esperaDasAutomacoesMs = 0;
ajustes.pausaEntreIdasMs = 0;

const CATEGORIAS = [
  { id: "cat-endereco", name: "Serviços de endereço", orderindex: 1 },
  { id: "cat-sp", name: "Salas privativas", orderindex: 5 },
  { id: "cat-one", name: "ONE", orderindex: 6 },
];

function tarefa(id: string, categoria = "cat-endereco", status = "pg pendente - renovação") {
  return {
    id,
    name: `(${id}) CLIENTE`,
    status: { status },
    custom_fields: [
      {
        id: "9acf7c8a-c46d-4bc3-90df-07a1540cb196",
        name: "CATEGORIA DE SERVIÇO",
        type: "drop_down",
        value: categoria,
        type_config: { options: CATEGORIAS },
      },
    ],
  };
}

function com(lista: Array<ReturnType<typeof tarefa>>) {
  listagem = lista;
  vivas = Object.fromEntries(lista.map((t) => [t.id, t]));
}

const reserva = (contratoId: number, tarefaId: string, resultado = "propagado"): Linha => ({
  id: `r${contratoId}`,
  provider: "RENOVACAO",
  externalId: `reajuste:${contratoId}:${REAJUSTE}`,
  resultado,
  detalhe: JSON.stringify({ contratoId, clienteId: 2129, tarefaId, problemas: [] }),
});

beforeEach(() => {
  config = { fecharNoPagamento: true };
  eventos = [reserva(3682, "t1")];
  retratos = [{ contratoId: 3682, clienteId: 2129 }];
  escritas = [];
  comentarios = [];
  aberturas = { clickup: 0, conexa: 0 };
  devolver = false;
  idasAoConexa = 0;
  contratoDoConexa = { id: 3682, customerId: 2129, amount: 88.98, isActive: true };
  cobrancas = [
    { chargeId: 31571, status: "paid", paymentDate: "2026-12-15", paidAmount: 88.98, salesIds: [88552, 89662] },
  ];
  vendasDoConexa = { 88552: { contractId: 3682 }, 89662: {} };
  com([tarefa("t1")]);
});

describe("fecharCiclosPagos: o caminho que funciona", () => {
  it("cliente pagou o valor reajustado: a tarefa vai para `ongoing`, com comentário e reserva fechada", async () => {
    const r = await fecharCiclosPagos({ forcar: true }, proximoAgora());

    expect(r.acao).toBe("conferido");
    expect(r.fechadas).toEqual(["(t1) CLIENTE"]);
    expect(escritas).toEqual(["t1/status=ongoing"]);
    expect(comentarios[0]).toContain("Ciclo fechado pelo sistema");
    expect(comentarios[0]).toContain("31571");
    expect(eventos.find((e) => e.externalId === `fechamento:3682:${REAJUSTE}`)?.resultado).toBe("fechada");
  });

  it("sala privativa vai para `ongoing - sala privativa`", async () => {
    com([tarefa("t1", "cat-sp")]);
    await fecharCiclosPagos({ forcar: true }, proximoAgora());
    expect(escritas).toEqual(["t1/status=ongoing - sala privativa"]);
  });

  it("⚠ rodar de novo não fecha de novo", async () => {
    await fecharCiclosPagos({ forcar: true }, proximoAgora());
    escritas = [];
    const r = await fecharCiclosPagos({ forcar: true }, proximoAgora());
    expect(r.acao).toBe("nada a fechar");
    expect(escritas).toEqual([]);
  });
});

describe("fecharCiclosPagos: quando NÃO fecha", () => {
  it("⚠ desligada, não abre nem o ClickUp nem o Conexa", async () => {
    config = { fecharNoPagamento: false };
    const r = await fecharCiclosPagos({ forcar: true }, proximoAgora());
    expect(r.acao).toBe("desligada");
    expect(aberturas).toEqual({ clickup: 0, conexa: 0 });
  });

  it("⚠ sem reserva de propagação nomeando tarefa, só o banco é lido", async () => {
    eventos = [];
    const r = await fecharCiclosPagos({ forcar: true }, proximoAgora());
    expect(r.acao).toBe("nada a fechar");
    expect(aberturas).toEqual({ clickup: 0, conexa: 0 });
  });

  it("a nomeada que NÃO está em `pg pendente` (ainda em notificação) espera: nem abre o Conexa", async () => {
    com([]);
    const r = await fecharCiclosPagos({ forcar: true }, proximoAgora());
    expect(r.acao).toBe("nada a fechar");
    expect(aberturas.conexa).toBe(0);
  });

  it("cliente que ainda não pagou: nada é escrito e não vira pendência", async () => {
    cobrancas = [];
    const r = await fecharCiclosPagos({ forcar: true }, proximoAgora());
    expect(escritas).toEqual([]);
    expect(r.pendentes).toEqual([]);
    expect(eventos.some((e) => e.externalId.startsWith("fechamento:"))).toBe(false);
  });

  it("⚠ pagou MENOS que o valor do contrato: não fecha", async () => {
    cobrancas = [{ chargeId: 31571, status: "paid", paymentDate: "2026-12-15", paidAmount: 80, salesIds: [88552] }];
    await fecharCiclosPagos({ forcar: true }, proximoAgora());
    expect(escritas).toEqual([]);
  });

  it("⚠ a cobrança paga é de OUTRA venda do cliente: não fecha", async () => {
    vendasDoConexa = { 88552: { contractId: 9999 }, 89662: {} };
    await fecharCiclosPagos({ forcar: true }, proximoAgora());
    expect(escritas).toEqual([]);
  });

  it("⚠ contrato encerrado não é fechado", async () => {
    contratoDoConexa = { id: 3682, customerId: 2129, amount: 88.98, isActive: false };
    const r = await fecharCiclosPagos({ forcar: true }, proximoAgora());
    expect(escritas).toEqual([]);
    expect(r.pendentes?.[0]).toContain("não está mais ativo");
  });

  it("⚠ ONE renova para um status que o sistema não deduz: fica pendente, sem reserva", async () => {
    com([tarefa("t1", "cat-one")]);
    const r = await fecharCiclosPagos({ forcar: true }, proximoAgora());
    expect(escritas).toEqual([]);
    expect(r.pendentes?.[0]).toContain("mova à mão");
    expect(eventos.some((e) => e.externalId.startsWith("fechamento:"))).toBe(false);
  });

  it("⚠ alguém moveu a tarefa agora há pouco: nada é escrito e a reserva é desfeita", async () => {
    // A listagem a vê em `pg pendente`, a leitura ao vivo já a vê em `ongoing`.
    vivas.t1 = tarefa("t1", "cat-endereco", "ongoing");
    const r = await fecharCiclosPagos({ forcar: true }, proximoAgora());
    expect(escritas).toEqual([]);
    expect(r.pendentes?.[0]).toContain("já não estava");
    expect(eventos.some((e) => e.externalId.startsWith("fechamento:"))).toBe(false);
  });

  it("⚠ a trava da lista DEVOLVE a tarefa: o sistema avisa, fecha a reserva como devolvida e não tenta de novo", async () => {
    devolver = true;
    const r = await fecharCiclosPagos({ forcar: true }, proximoAgora());

    expect(r.fechadas).toEqual([]);
    expect(r.pendentes?.[0]).toContain("devolveu");
    expect(comentarios[0]).toContain("devolveu a tarefa");
    expect(eventos.find((e) => e.externalId === `fechamento:3682:${REAJUSTE}`)?.resultado).toBe("devolvida");

    escritas = [];
    const segunda = await fecharCiclosPagos({ forcar: true }, proximoAgora());
    expect(segunda.acao).toBe("nada a fechar");
    expect(escritas).toEqual([]);
  });
});

describe("fecharCiclosPagos: o Conexa e o rodízio", () => {
  it("⚠ quem foi conferido há menos de 3 h espera a vez: a segunda rodada não vai ao Conexa", async () => {
    cobrancas = [];
    const agora = proximoAgora();
    await fecharCiclosPagos({ forcar: true }, agora);
    const antes = idasAoConexa;

    await fecharCiclosPagos({ forcar: true }, new Date(agora.getTime() + HORA));

    expect(idasAoConexa).toBe(antes);
  });

  it("(5051) quatro contratos de um cliente leem as cobranças UMA vez e fecham os quatro", async () => {
    const contratos = [10574, 10576, 10578, 10580];
    eventos = contratos.map((c, i) => reserva(c, `t${i + 1}`));
    retratos = contratos.map((c) => ({ contratoId: c, clienteId: 5051 }));
    com(contratos.map((_, i) => tarefa(`t${i + 1}`)));
    cobrancas = [
      { chargeId: 40000, status: "paid", paymentDate: "2026-12-15", paidAmount: 417.92, salesIds: [1, 2, 3, 4] },
    ];
    vendasDoConexa = { 1: { contractId: 10574 }, 2: { contractId: 10576 }, 3: { contractId: 10578 }, 4: { contractId: 10580 } };
    contratoDoConexa = { id: 0, customerId: 5051, amount: 104.48, isActive: true };

    const r = await fecharCiclosPagos({ forcar: true }, proximoAgora());

    expect(r.fechadas).toHaveLength(4);
    expect(escritas.sort()).toEqual(["t1", "t2", "t3", "t4"].map((t) => `${t}/status=ongoing`));
    // 4 contratos + 1 lista de cobranças + 4 vendas = 9 idas ao Conexa, não 4 × 6.
    expect(idasAoConexa).toBe(9);
  });
});

describe("candidatosDoFechamento", () => {
  it("lê contrato e data da chave e a tarefa do detalhe, e só dos desfechos que tocaram a tarefa", () => {
    const r = candidatosDoFechamento([
      reserva(1, "a"),
      reserva(2, "b", "reservado"),
      { ...reserva(3, "c"), detalhe: null },
      { ...reserva(4, "d"), externalId: "reajuste:4:lixo" },
    ]);
    expect(r).toEqual([{ tarefaId: "a", contratoId: 1, reajusteEm: REAJUSTE }]);
  });
});
