import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rodada do ganho da venda autônoma com banco, ClickUp e Conexa simulados: o
 * que é escrito na task, quando NADA é escrito, e quando nem se abre o Conexa.
 */

// Segunda-feira, 10h em São Paulo.
const AGORA = new Date("2026-10-19T13:00:00Z");
const CRIADA = new Date("2026-10-14T03:26:00Z");
const CRM = "901302419821";

type Linha = {
  id: string;
  provider: string;
  externalId: string;
  resultado: string | null;
  detalhe?: string | null;
};

let chamadasDoBanco: Array<Record<string, unknown>> = [];
let eventos: Linha[] = [];
let reservas: Record<number, Record<string, unknown>> = {};
let cobrancas: Record<number, Record<string, unknown>> = {};
let tarefas: Record<string, Record<string, unknown>> = {};
let escritas: string[] = [];
let conexaAberto = 0;
let falhaNaEtiqueta = false;
let doContato: Record<string, unknown> = {};
let camposExtras: Array<Record<string, unknown>> = [];

vi.mock("@/lib/db", () => ({
  db: {
    toolCall: { findMany: async () => chamadasDoBanco },
    conversation: {
      findUnique: async () => ({ chatwootConversationId: 14592, portaAgentId: "porta", agentId: null }),
    },
    webhookEvent: {
      findMany: async ({ where }: { where: { externalId: { in: string[] } } }) =>
        eventos.filter((e) => where.externalId.in.includes(e.externalId)),
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
    },
  },
}));

vi.mock("@/server/contato/espelho", () => ({
  atributosDoContatoDaConversa: async () => doContato,
}));

vi.mock("@/server/integrations/conexa/sistema", () => ({
  abrirConexa: async () => {
    conexaAberto += 1;
    return {
      cliente: {
        obterReserva: async (id: number) => reservas[id],
        obterCobranca: async (id: number) => cobrancas[id],
        listarCobrancas: async () => ({ itens: Object.values(cobrancas), temMais: false }),
      },
    };
  },
}));

vi.mock("@/server/integrations/clickup/sistema", () => ({
  abrirClickUp: async () => ({
    cliente: {
      obterTarefa: async (id: string) => tarefas[id],
      listarCamposPersonalizados: async () => ({
        fields: [
          {
            id: "vend",
            name: "VENDEDOR",
            type: "drop_down",
            type_config: { options: [{ id: "op-alan", name: "Alan", orderindex: 0 }, { id: "op-auto", name: "Auto Venda", orderindex: 4 }] },
          },
          { id: "dg", name: "Data ganho", type: "date" },
          ...camposExtras,
        ],
      }),
    },
    executar: async (ferramenta: string, entrada: Record<string, unknown>) => {
      if (ferramenta === "clickup_adicionar_tag" && falhaNaEtiqueta) throw new Error("ClickUp respondeu 500");
      escritas.push(`${ferramenta}:${JSON.stringify(entrada)}`);
      return "ok";
    },
  }),
}));

const { conferirAutoVendas, reiniciarRelogioDaAutoVenda } = await import("./conferir");

function vendaAutonoma(reservaId: number, tarefaId: string, cobrancaId: number | null = 31735) {
  const base = { createdAt: CRIADA, run: { conversationId: "conv-1" } };
  chamadasDoBanco.push(
    {
      ...base,
      toolName: "conexa_criar_reserva",
      input: {},
      output: { criada: true, reserva: { id: reservaId, inicio: "2026-10-15T09:30:00-03:00" } },
    },
    { ...base, createdAt: new Date(CRIADA.getTime() + 60_000), toolName: "clickup_criar_tarefa", input: {}, output: { criada: true, id: tarefaId } },
  );
  if (cobrancaId) {
    chamadasDoBanco.push({
      ...base,
      toolName: "conexa_faturar_reserva",
      input: { reservaId },
      output: { faturada: true, cobranca: { id: cobrancaId } },
    });
  }
}

function tarefaAutoVenda(id: string, extra: Record<string, unknown> = {}) {
  tarefas[id] = { id, name: "CW — Cliente", list: { id: CRM }, tags: [], custom_fields: [{ id: "vend", value: 4 }], ...extra };
}

beforeEach(() => {
  reiniciarRelogioDaAutoVenda();
  chamadasDoBanco = [];
  eventos = [];
  reservas = {};
  cobrancas = {};
  tarefas = {};
  escritas = [];
  conexaAberto = 0;
  falhaNaEtiqueta = false;
  doContato = {};
  camposExtras = [];
});

const rodar = () => conferirAutoVendas(AGORA, { esperar: true });

describe("conferirAutoVendas", () => {
  it("reserva paga com task Auto Venda: etiqueta, Data ganho com o dia do pagamento e comentário", async () => {
    vendaAutonoma(29181, "17twvjwu041");
    reservas[29181] = { status: "paid", saleId: 900, customerId: 50 };
    cobrancas[31735] = { chargeId: 31735, status: "paid", paymentDate: "2026-10-15", paidAmount: 140 };
    tarefaAutoVenda("17twvjwu041");

    const r = await rodar();

    expect(r).toMatchObject({ acao: "conferido", ganhos: 1, falhas: 0 });
    expect(escritas[0]).toBe('clickup_adicionar_tag:{"tarefaId":"17twvjwu041","tag":"ganho"}');
    expect(escritas[1]).toBe(
      'clickup_definir_campo_personalizado:{"tarefaId":"17twvjwu041","campos":[{"campo":"Data ganho","valor":"2026-10-15"}]}',
    );
    expect(escritas[2]).toContain("reserva 29181 — cobrança 31735");
    expect(eventos).toMatchObject([{ externalId: "reserva:29181", resultado: "ganho" }]);

    // A rodada seguinte não escreve de novo.
    reiniciarRelogioDaAutoVenda();
    escritas = [];
    expect(await rodar()).toMatchObject({ reservas: 0, ganhos: 0 });
    expect(escritas).toEqual([]);
  });

  it("sem cobrança do agente (a equipe faturou), acha a paga pela venda da reserva", async () => {
    vendaAutonoma(1, "t1", null);
    reservas[1] = { status: "paid", saleId: 900, customerId: 50 };
    cobrancas[777] = { chargeId: 777, status: "paid", paymentDate: "2026-10-16", salesIds: [900] };
    tarefaAutoVenda("t1");

    await rodar();
    expect(escritas[1]).toContain('"valor":"2026-10-16"');
  });

  it("não troca a Data ganho que alguém já preencheu", async () => {
    vendaAutonoma(1, "t1");
    reservas[1] = { status: "paid" };
    cobrancas[31735] = { chargeId: 31735, status: "paid", paymentDate: "2026-10-15" };
    tarefaAutoVenda("t1", { custom_fields: [{ id: "vend", value: 4 }, { id: "dg", value: "1790000000000" }] });

    await rodar();
    expect(escritas.map((e) => e.split(":")[0])).toEqual(["clickup_adicionar_tag", "clickup_comentar_tarefa"]);
  });

  it("task já ganha pela equipe sai da fila sem nenhuma escrita", async () => {
    vendaAutonoma(1, "t1");
    reservas[1] = { status: "paid" };
    tarefaAutoVenda("t1", { tags: [{ name: "ganho" }] });

    expect(await rodar()).toMatchObject({ encerradas: 1, ganhos: 0 });
    expect(escritas).toEqual([]);
    expect(eventos[0]).toMatchObject({ resultado: "encerrado", detalhe: "a task já estava como ganho" });
  });

  it("ainda não paga: espera, sem abrir o ClickUp e sem registro", async () => {
    vendaAutonoma(1, "t1");
    reservas[1] = { status: "billed" };
    tarefaAutoVenda("t1");

    expect(await rodar()).toMatchObject({ esperando: 1, ganhos: 0 });
    expect(escritas).toEqual([]);
    expect(eventos).toEqual([]);
  });

  it("descontada do pacote de horas sai da fila sem ganho", async () => {
    vendaAutonoma(1, "t1", null);
    reservas[1] = { status: "deductedFromQuota" };
    tarefaAutoVenda("t1");

    expect(await rodar()).toMatchObject({ encerradas: 1 });
    expect(escritas).toEqual([]);
  });

  it("paga, mas VENDEDOR de pessoa: espera a equipe corrigir, sem escrever", async () => {
    vendaAutonoma(1, "t1");
    reservas[1] = { status: "paid" };
    tarefaAutoVenda("t1", { custom_fields: [{ id: "vend", value: 0 }] });

    expect(await rodar()).toMatchObject({ esperando: 1, ganhos: 0 });
    expect(escritas).toEqual([]);
    expect(eventos).toEqual([]);
  });

  it("pula a task de outra lista e acha a do CRM Comercial na mesma conversa", async () => {
    vendaAutonoma(1, "crm");
    chamadasDoBanco.push({
      createdAt: CRIADA,
      run: { conversationId: "conv-1" },
      toolName: "clickup_criar_tarefa",
      input: {},
      output: { criada: true, id: "atendimentos" },
    });
    reservas[1] = { status: "paid" };
    cobrancas[31735] = { chargeId: 31735, status: "paid", paymentDate: "2026-10-15" };
    tarefas.atendimentos = { id: "atendimentos", name: "x", list: { id: "901306195904" }, tags: [] };
    tarefaAutoVenda("crm");

    expect(await rodar()).toMatchObject({ ganhos: 1 });
    expect(escritas[0]).toContain('"tarefaId":"crm"');
  });

  it("etiqueta que não entrou desfaz a reserva: a rodada seguinte tenta de novo", async () => {
    vendaAutonoma(1, "t1");
    reservas[1] = { status: "paid" };
    tarefaAutoVenda("t1");
    falhaNaEtiqueta = true;

    expect(await rodar()).toMatchObject({ ganhos: 0, falhas: 1 });
    expect(eventos).toEqual([]);
  });

  it("sem venda autônoma na fila, nem abre o Conexa", async () => {
    expect(await rodar()).toMatchObject({ reservas: 0 });
    expect(conexaAberto).toBe(0);
  });

  it("fora do horário comercial não roda", async () => {
    const sabado = new Date("2026-10-17T13:00:00Z");
    expect(await conferirAutoVendas(sabado)).toEqual({ acao: "fora do horário" });
  });
});

describe("os campos que o ganho preenche", () => {
  it("Status CRM, valor pago e o canal do contato; opção que não existe fica de fora sozinha", async () => {
    camposExtras = [
      {
        id: "st",
        name: "Status CRM",
        type: "drop_down",
        type_config: { options: [{ id: "g", name: "Ganho", orderindex: 1 }, { id: "a", name: "Em andamento", orderindex: 2 }] },
      },
      { id: "v", name: "VALOR CONTRATO", type: "currency" },
      { id: "c", name: "CANAL", type: "drop_down", type_config: { options: [{ id: "rs", name: "Redes sociais", orderindex: 7 }] } },
      { id: "r", name: "RAMO DE ATIVIDADE", type: "drop_down", type_config: { options: [{ id: "f", name: "Finaceiro", orderindex: 0 }] } },
    ];
    doContato = { canal: "Redes sociais", ramo_de_atividade: "Financeiro" };
    vendaAutonoma(29181, "t1");
    reservas[29181] = { status: "paid" };
    cobrancas[31735] = { chargeId: 31735, status: "paid", paymentDate: "2026-10-15", paidAmount: 140 };
    tarefaAutoVenda("t1");

    expect(await rodar()).toMatchObject({ ganhos: 1 });
    const campos = JSON.parse(escritas[1].slice(escritas[1].indexOf(":") + 1)).campos;
    expect(campos).toEqual([
      { campo: "Status CRM", valor: "Ganho" },
      { campo: "Data ganho", valor: "2026-10-15" },
      { campo: "VALOR CONTRATO", valor: 140 },
      { campo: "CANAL", valor: "Redes sociais" },
    ]);
    expect(escritas[2]).toContain("Campos preenchidos: Status CRM, Data ganho, VALOR CONTRATO, CANAL.");
  });
});
