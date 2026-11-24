import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Uma entrega da automação 8 com banco, ClickUp e Conexa simulados. O caso base
 * é o `(5051)`: tarefa de R$ 99,90 → 104,48 e fidelidade de 27/11/2026.
 */

const CAMPO_REAJUSTE = "0231d769-5063-439d-8b03-ad660c6bada5";
const CAMPO_ENCERRAMENTO = "885c7420-baa9-4125-95cd-53934b47b147";
const CAMPO_VALOR = "0dad1007-feb0-437a-9051-87bbac539d4c";
const CAMPO_LINK = "4f3ca1c7-2933-49d5-b2de-d6e9c8d506bd";
/** 27/11/2026, meio-dia em São Paulo. */
const NOV_27 = Date.UTC(2026, 10, 27, 15);

type Linha = { id: string; provider: string; externalId: string; resultado: string | null; detalhe?: string | null; createdAt: Date };

let modo: "desligado" | "sombra" | "ligado" = "ligado";
let eventos: Linha[] = [];
let tarefaViva: Record<string, unknown> = {};
let escritas: Array<{ campo: string; valor: unknown }> = [];
let comentarios: string[] = [];
let contratosDoConexa: Array<Record<string, unknown>> = [];
let patches: Array<{ id: number; data: string }> = [];
let recusarPatch = false;
let patchNaoPersiste = false;
let recusarCampos = false;
let aberturas = { clickup: 0, conexa: 0 };

vi.mock("@/lib/db", () => ({
  db: {
    retratoDeRenovacao: {
      findMany: async () => [{ contratoId: 10574, valorCentavos: 9990, reajusteDoRetrato: "2026-10-01", reajusteEm: "2026-10-23" }],
    },
    webhookEvent: {
      findFirst: async ({ where }: { where: { externalId: { startsWith: string } } }) =>
        eventos.find((e) => e.externalId.startsWith(where.externalId.startsWith)) ?? null,
      create: async ({ data }: { data: Omit<Linha, "id" | "createdAt"> }) => {
        if (eventos.some((e) => e.provider === data.provider && e.externalId === data.externalId)) {
          throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        }
        const linha = { id: `e${eventos.length + 1}`, createdAt: new Date(), ...data };
        eventos.push(linha);
        return linha;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Linha> }) =>
        Object.assign(eventos.find((e) => e.id === where.id)!, data),
      delete: async ({ where }: { where: { id: string } }) => {
        eventos = eventos.filter((e) => e.id !== where.id);
      },
    },
  },
}));

vi.mock("./config", () => ({
  configDaRenovacao: async () => ({ avancarDatas: modo }),
  hostDoConexaDaSeahub: async () => "seahubcoworking.conexa.app",
}));

vi.mock("@/server/integrations/clickup/sistema", () => ({
  abrirClickUp: async () => {
    aberturas.clickup += 1;
    return {
      cliente: {
        obterTarefa: async () => tarefaViva,
        definirCampoPersonalizado: async (_id: string, campo: string, valor: unknown) => {
          if (recusarCampos) throw new Error("ClickUp respondeu 400");
          escritas.push({ campo, valor });
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
        listarContratos: async () => ({ itens: contratosDoConexa, temMais: false }),
        obterContrato: async (id: number) => contratosDoConexa.find((c) => c.contractId === id) ?? {},
        atualizarFidelidadeDoContrato: async (id: number, data: string) => {
          if (recusarPatch) throw new Error("Conexa respondeu 500");
          patches.push({ id, data });
          if (!patchNaoPersiste) {
            const c = contratosDoConexa.find((x) => x.contractId === id);
            if (c) c.fidelityDate = data;
          }
        },
      },
      config: {},
      executar: async () => undefined,
    };
  },
}));

const { processarDatas, FREIO_POR_TAREFA_MS } = await import("./datas-processar");

const pedido = {
  tarefaId: "86adjmaqg",
  dataReajuste: "2026-11-27",
  dataEncerramento: "2026-11-27",
};

const contratoCru = (id: number, extra: Record<string, unknown> = {}) => ({
  contractId: id,
  customerId: 5051,
  amount: 104.48,
  fidelityDate: "2026-11-27",
  isActive: true,
  ...extra,
});

function tarefa(status = "ongoing") {
  return {
    id: "86adjmaqg",
    name: "(5051) PAULO HENRIQUE MACIEL BARROSO",
    status: { status },
    custom_fields: [
      { id: CAMPO_VALOR, value: "104.48" },
      { id: CAMPO_REAJUSTE, value: String(NOV_27) },
      { id: CAMPO_ENCERRAMENTO, value: String(Date.UTC(2027, 10, 16, 15)) },
      { id: CAMPO_LINK, value: "https://seahubcoworking.conexa.app/index.php?r=y&idCliente=5051" },
    ],
  };
}

beforeEach(() => {
  modo = "ligado";
  eventos = [];
  escritas = [];
  comentarios = [];
  patches = [];
  recusarPatch = false;
  patchNaoPersiste = false;
  recusarCampos = false;
  aberturas = { clickup: 0, conexa: 0 };
  tarefaViva = tarefa();
  contratosDoConexa = [contratoCru(10574)];
  // O "hoje" do plano entra na conta do contrato (o ciclo de agora): data fixa,
  // para o teste não mudar de resposta com o calendário.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-28T15:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("processarDatas: o caminho que funciona", () => {
  it("avança a fidelidade no Conexa (lendo de volta) e as duas datas da tarefa, e comenta", async () => {
    const r = await processarDatas(pedido);

    expect(r.resultado).toBe("avançado");
    expect(patches).toEqual([{ id: 10574, data: "2027-11-27" }]);
    expect(escritas.map((e) => e.campo).sort()).toEqual([CAMPO_REAJUSTE, CAMPO_ENCERRAMENTO].sort());
    // Meio-dia em São Paulo de 27/11/2027.
    expect(escritas.find((e) => e.campo === CAMPO_REAJUSTE)?.valor).toBe(Date.UTC(2027, 10, 27, 15));
    expect(comentarios[0]).toContain("Datas da renovação avançadas");
    expect(comentarios[0]).toContain("27/11/2026 → 27/11/2027");
    expect(eventos.find((e) => e.externalId === "datas:86adjmaqg:2026-11-27")?.resultado).toBe("avançado");
  });

  it("o contrato vem do retrato como valor de antes: separa produtos de valores diferentes", async () => {
    // Dois contratos do cliente, de valores diferentes; a tarefa é a do de R$ 104,48.
    contratosDoConexa = [
      contratoCru(555, { amount: 5800, fidelityDate: "2026-11-27" }),
      contratoCru(10574),
    ];
    await processarDatas(pedido);
    expect(patches).toEqual([{ id: 10574, data: "2027-11-27" }]);
  });
});

describe("processarDatas: os modos", () => {
  it("⚠ desligado não abre nem o ClickUp nem o Conexa", async () => {
    modo = "desligado";
    const r = await processarDatas(pedido);
    expect(r.resultado).toBe("desligado");
    expect(aberturas).toEqual({ clickup: 0, conexa: 0 });
  });

  it("⚠ sombra lê e registra o plano, mas NÃO escreve nada", async () => {
    modo = "sombra";
    const r = await processarDatas(pedido);

    expect(r.resultado).toBe("sombra");
    expect(patches).toEqual([]);
    expect(escritas).toEqual([]);
    expect(comentarios).toEqual([]);
    const linha = eventos.find((e) => e.externalId === "datas-sombra:86adjmaqg:2026-11-27");
    expect(linha?.resultado).toBe("sombra");
    expect(linha?.detalhe).toContain("2027-11-27");
  });

  it("a reserva da sombra NÃO trava o modo ligado depois", async () => {
    modo = "sombra";
    await processarDatas(pedido);
    modo = "ligado";
    const r = await processarDatas(pedido);
    expect(r.resultado).toBe("avançado");
  });
});

describe("processarDatas: o que NÃO faz", () => {
  it("⚠ sem o id da tarefa, recusa", async () => {
    const r = await processarDatas({ ...pedido, tarefaId: null });
    expect(r.resultado).toBe("recusado");
    expect(aberturas.clickup).toBe(0);
  });

  it("⚠ tarefa que NÃO está num status de continuidade não tem as datas avançadas", async () => {
    tarefaViva = tarefa("😢 distrato");
    const r = await processarDatas(pedido);
    expect(r.resultado).toBe("ignorado");
    expect(patches).toEqual([]);
    expect(escritas).toEqual([]);
    expect(eventos).toEqual([]);
  });

  it("⚠ a mesma entrega duas vezes avança UMA", async () => {
    await processarDatas(pedido);
    patches = [];
    escritas = [];

    const segunda = await processarDatas(pedido);

    expect(segunda.resultado).toBe("repetida");
    expect(patches).toEqual([]);
    expect(escritas).toEqual([]);
  });

  it("⚠ mesmo sem a data na URL, a segunda entrega no mesmo dia não avança de novo", async () => {
    // Sem `datadereajuste` na URL, a segunda chamada partiria da data JÁ avançada.
    await processarDatas({ ...pedido, dataReajuste: null, dataEncerramento: null });
    escritas = [];
    patches = [];
    // A tarefa agora mostra a data avançada, como o ClickUp a mostraria.
    tarefaViva = {
      ...tarefa(),
      custom_fields: tarefa().custom_fields.map((c) =>
        c.id === CAMPO_REAJUSTE ? { ...c, value: String(Date.UTC(2027, 10, 27, 15)) } : c,
      ),
    };

    const r = await processarDatas({ ...pedido, dataReajuste: null, dataEncerramento: null });

    expect(r.resultado).toBe("repetida");
    expect(patches).toEqual([]);
    expect(FREIO_POR_TAREFA_MS).toBe(20 * 60 * 60_000);
  });

  it("⚠ sem contrato com a fidelidade perto, o Conexa não é tocado e o comentário diz por quê", async () => {
    contratosDoConexa = [contratoCru(10574, { fidelityDate: "2027-11-27" })];
    const r = await processarDatas(pedido);

    expect(patches).toEqual([]);
    expect(r.resultado).toBe("avançado");
    expect(escritas.length).toBe(2);
    expect(comentarios[0]).toContain("Fidelidade no Conexa não alterada");
  });
});

describe("processarDatas: dados tortos (24/11/2026)", () => {
  it("⚠ DATA DE REAJUSTE gravada em massa (01/12/2027): liga pelo valor e a data volta à fidelidade nova", async () => {
    const DEZ_01_2027 = Date.UTC(2027, 11, 1, 15);
    tarefaViva = {
      ...tarefa(),
      custom_fields: [
        { id: CAMPO_VALOR, value: "104.48" },
        { id: CAMPO_REAJUSTE, value: String(DEZ_01_2027) },
        { id: CAMPO_LINK, value: "https://seahubcoworking.conexa.app/index.php?r=y&idCliente=5051" },
      ],
    };
    await processarDatas({ tarefaId: "86adjmaqg", dataReajuste: "2027-12-01", dataEncerramento: null });

    expect(patches).toEqual([{ id: 10574, data: "2027-11-27" }]);
    // 27/11/2027, e não 01/12/2028 ("data da tarefa + 1 ano").
    expect(escritas.find((e) => e.campo === CAMPO_REAJUSTE)?.valor).toBe(Date.UTC(2027, 10, 27, 15));
    expect(comentarios[0]).toContain("ligado pelo valor");
  });

  it("⚠ tarefa da ONE Empreendimentos (outro Conexa): o Conexa da Seahub nem é aberto", async () => {
    tarefaViva = {
      ...tarefa("one"),
      name: "(72) BANDEIRANTES PROPAGANDA POTIGUAR LTDA",
      custom_fields: [
        { id: CAMPO_VALOR, value: "3367.26" },
        { id: CAMPO_REAJUSTE, value: String(NOV_27) },
        { id: CAMPO_LINK, value: "https://oneempreendimentos.conexa.app/index.php?r=y&idCliente=72#" },
      ],
    };
    contratosDoConexa = [contratoCru(3137, { customerId: 72 })];

    await processarDatas(pedido);

    expect(aberturas.conexa).toBe(0);
    expect(patches).toEqual([]);
    expect(comentarios[0]).toContain("outra conta do Conexa");
  });
});

describe("processarDatas: quando algo falha", () => {
  it("⚠ o Conexa aceita o PATCH mas NÃO persiste: lido de volta, vira erro — e as datas da tarefa ainda avançam", async () => {
    patchNaoPersiste = true;
    const r = await processarDatas(pedido);

    expect(r.resultado).toBe("em parte");
    expect(r.detalhe).toContain("devolveu a fidelidade");
    expect(escritas.length).toBe(2);
    expect(comentarios[0]).toContain("NÃO foi alterada");
    expect(eventos.find((e) => e.externalId.startsWith("datas:"))?.resultado).toBe("em parte");
  });

  it("⚠ o Conexa recusa o PATCH: a tarefa avança e o erro fica dito", async () => {
    recusarPatch = true;
    const r = await processarDatas(pedido);
    expect(r.resultado).toBe("em parte");
    expect(r.detalhe).toContain("Conexa respondeu 500");
    expect(escritas.length).toBe(2);
  });

  it("⚠ NADA entrou: a reserva é desfeita e a próxima entrega tenta de novo", async () => {
    recusarPatch = true;
    recusarCampos = true;
    const r = await processarDatas(pedido);

    expect(r.resultado).toBe("falhou");
    expect(eventos.some((e) => e.externalId.startsWith("datas:"))).toBe(false);

    recusarPatch = false;
    recusarCampos = false;
    expect((await processarDatas(pedido)).resultado).toBe("avançado");
  });
});
