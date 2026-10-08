import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConexaApiError } from "@/server/integrations/conexa/client";

/**
 * A rodada das notas fiscais em modo sombra, com banco e Conexa simulados: o
 * que é lido, o que é gravado, e o que NÃO é lido de novo.
 */

// Segunda-feira, 05/10/2026, 10h em São Paulo.
const AGORA = new Date("2026-10-05T13:00:00Z");

type Linha = Record<string, unknown> & { id: string; cobrancaId: number; criadaEm: Date };

let linhas: Linha[] = [];
let ligada = true;
let config: Record<string, unknown> = {};
let conexaAberto = true;
let pagas: Array<Record<string, unknown>> = [];
let emAberto: Array<Record<string, unknown>> = [];
let vendas: Record<number, Record<string, unknown>> = {};
let produtos: Record<number, Record<string, unknown>> = {};
let chamadas: string[] = [];
let vendaQueFalha: number | null = null;
let estadoDaIntegracao: Record<string, unknown> = {};

vi.mock("@/lib/db", () => ({
  db: {
    integration: {
      findUnique: async () => ({ enabled: ligada, config }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        estadoDaIntegracao = data;
        return {};
      },
    },
    cobrancaFiscal: {
      findMany: async ({ where }: { where: { cobrancaId?: { in: number[] }; modo?: string } }) => {
        if (where.cobrancaId) return linhas.filter((l) => where.cobrancaId!.in.includes(l.cobrancaId));
        return linhas.filter((l) => l.modo === where.modo);
      },
      create: async ({ data }: { data: Omit<Linha, "id" | "criadaEm"> }) => {
        if (linhas.some((l) => l.cobrancaId === data.cobrancaId)) {
          throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        }
        const linha = { id: `l${linhas.length + 1}`, criadaEm: AGORA, ...data } as Linha;
        linhas.push(linha);
        return linha;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        Object.assign(linhas.find((l) => l.id === where.id)!, data);
        return {};
      },
      delete: async ({ where }: { where: { id: string } }) => {
        linhas = linhas.filter((l) => l.id !== where.id);
        return {};
      },
    },
  },
}));

vi.mock("@/server/integrations/conexa/sistema", () => ({
  abrirConexa: async () =>
    conexaAberto
      ? {
          cliente: {
            listarCobrancas: async (f: Record<string, unknown>) => {
              chamadas.push(`listar:${f.status}:${f.paymentDateFrom ?? ""}:${f.customerId ?? ""}`);
              return { itens: f.status === "paid" ? pagas : emAberto, temMais: false };
            },
            obterCobranca: async (id: number) => {
              chamadas.push(`cobranca:${id}`);
              const achada = [...pagas, ...emAberto].find((c) => c.chargeId === id);
              if (!achada) throw new ConexaApiError(404, "This Charge does not exist");
              return achada;
            },
            obterVenda: async (id: number) => {
              chamadas.push(`venda:${id}`);
              if (id === vendaQueFalha) throw new Error("Conexa respondeu 500");
              return vendas[id];
            },
            obterProduto: async (id: number) => {
              chamadas.push(`produto:${id}`);
              if (!produtos[id]) throw new ConexaApiError(404, "This Product does not exist");
              return produtos[id];
            },
          },
        }
      : { erro: "a integração do Conexa está desligada" },
}));

const { conferirNotasFiscais, conferirUmaCobranca, reiniciarRelogioDasNotas, reclassificar } = await import("./conferir");
const { lerConfigNotasFiscais } = await import("./config");

const rodar = () => conferirNotasFiscais(AGORA, { esperar: true, forcar: true });

const cobranca = (id: number, salesIds: number[], extra: Record<string, unknown> = {}) => ({
  chargeId: id,
  companyId: 3,
  customerId: 70 + id,
  type: "contractual",
  status: "paid",
  amount: 149,
  paidAmount: 149,
  paymentDate: "2026-10-05",
  competenceDate: "2026-10-01",
  createdAt: "2026-09-24T09:00:00-03:00",
  hasISSRetention: false,
  taxInvoiceNumber: null,
  salesIds,
  ...extra,
});

beforeEach(() => {
  reiniciarRelogioDasNotas();
  linhas = [];
  ligada = true;
  config = { codigos: { "10": "03.03.02", "3": "10.05.01" }, codigoReservaDeSala: "03.03.02" };
  conexaAberto = true;
  pagas = [];
  emAberto = [];
  chamadas = [];
  vendaQueFalha = null;
  estadoDaIntegracao = {};
  vendas = {
    1: { saleId: 1, product: { id: 2970, name: "EV - Endereço Fiscal Batial Mensal" }, amount: 149, quantity: 1 },
    2: { saleId: 2, product: { id: 2880, name: "[SEAWAY] - SALA DE ATENDIMENTO 02 - 3 pessoas" }, amount: 0, quantity: 1 },
    3: { saleId: 3, product: { id: 2970, name: "EV - Endereço Fiscal Batial Mensal" }, amount: 149, quantity: 1 },
    4: { saleId: 4, product: { id: 35, name: "Contrato: Sala 01 - Nações" }, amount: 1200, quantity: 1 },
  };
  produtos = {
    2970: { productId: 2970, categoryId: 10 },
    35: { productId: 35, categoryId: 8 },
  };
});

describe("notas fiscais em modo sombra", () => {
  it("desligada não abre o Conexa", async () => {
    ligada = false;
    expect(await rodar()).toEqual({ acao: "desligada" });
    expect(chamadas).toEqual([]);
  });

  it("lê as pagas do dia, classifica pela categoria e grava a nota que emitiria", async () => {
    pagas = [cobranca(900, [1, 2])];
    const r = await rodar();
    expect(r).toMatchObject({ acao: "conferido", vistas: 1, registradas: 1, falhas: 0, incompleta: false });
    expect(chamadas).toEqual(["listar:paid:2026-10-05:", "venda:1", "produto:2970", "venda:2", "produto:2880"]);
    expect(linhas[0]).toMatchObject({
      cobrancaId: 900,
      modo: "sombra",
      situacao: "PRONTA",
      notas: [expect.objectContaining({ codigo: "03.03.02", valorCentavos: 14900, chave: "conexa-900-030302" })],
    });
    expect(estadoDaIntegracao).toMatchObject({ status: "OK", lastError: null });
  });

  it("⚠ cobrança já vista não é lida de novo — nem as vendas", async () => {
    pagas = [cobranca(900, [1])];
    await rodar();
    chamadas = [];
    reiniciarRelogioDasNotas();
    const r = await rodar();
    expect(r).toMatchObject({ vistas: 1, novas: 0, registradas: 0 });
    expect(chamadas).toEqual(["listar:paid:2026-10-05:"]);
  });

  it("o mesmo produto é lido uma vez por rodada", async () => {
    pagas = [cobranca(900, [1]), cobranca(901, [3])];
    await rodar();
    expect(chamadas.filter((c) => c === "produto:2970")).toHaveLength(1);
  });

  it("⚠ falha ao ler uma venda não grava a cobrança pela metade: fica para a próxima rodada", async () => {
    pagas = [cobranca(900, [1]), cobranca(901, [3])];
    vendaQueFalha = 1;
    const r = await rodar();
    expect(r).toMatchObject({ registradas: 1, falhas: 1 });
    expect(linhas.map((l) => l.cobrancaId)).toEqual([901]);
    expect(estadoDaIntegracao.lastError).toMatch(/1 cobrança\(s\) não lida\(s\)/);

    vendaQueFalha = null;
    reiniciarRelogioDasNotas();
    await rodar();
    expect(linhas.map((l) => l.cobrancaId).sort()).toEqual([900, 901]);
  });

  it("cliente 'nunca' fica fora SEM ler as vendas", async () => {
    config = { ...config, clientes: [{ clienteId: 970, regra: "nunca" }] };
    pagas = [cobranca(900, [1])];
    await rodar();
    expect(chamadas).toEqual(["listar:paid:2026-10-05:"]);
    expect(linhas[0]).toMatchObject({ situacao: "FORA_DA_REGRA", itens: [] });
  });

  it("clientes 'antes': lê as em aberto deles e fica só com as geradas na janela", async () => {
    config = { ...config, inicio: "2026-10-01", clientes: [{ clienteId: 980, regra: "antes" }] };
    emAberto = [
      cobranca(910, [1], { customerId: 980, status: "unpaid", paidAmount: null, paymentDate: null, createdAt: "2026-10-02T10:00:00-03:00" }),
      cobranca(911, [3], { customerId: 980, status: "unpaid", paidAmount: null, paymentDate: null, createdAt: "2026-09-10T10:00:00-03:00" }),
    ];
    await rodar();
    expect(chamadas).toContain("listar:unpaid::980");
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ cobrancaId: 910, evento: "gerada", situacao: "PRONTA" });
  });

  it("sem o Conexa a rodada registra o motivo e não grava nada", async () => {
    conexaAberto = false;
    const r = await rodar();
    expect(r.erro).toMatch(/desligada/);
    expect(estadoDaIntegracao).toMatchObject({ status: "ERROR" });
    expect(linhas).toEqual([]);
  });

  describe("reclassificar ao salvar a tabela", () => {
    it("a categoria que ganhou código tira a cobrança de 'aguardando'", async () => {
      pagas = [cobranca(900, [4], { amount: 1200, paidAmount: 1200 })];
      await rodar();
      expect(linhas[0]).toMatchObject({ situacao: "AGUARDANDO_CLASSIFICACAO" });

      const r = await reclassificar(
        lerConfigNotasFiscais({ codigos: { "10": "03.03.02", "8": "10.05.01" } }),
        AGORA,
      );
      expect(r).toEqual({ mudadas: 1, apagadas: 0 });
      expect(linhas[0]).toMatchObject({
        situacao: "PRONTA",
        notas: [expect.objectContaining({ codigo: "10.05.01", valorCentavos: 120000 })],
      });
    });

    it("⚠ o jsonb devolve as chaves em outra ordem: nada muda, nada é regravado", async () => {
      pagas = [cobranca(900, [1])];
      await rodar();
      // Como o Postgres devolve: chaves ordenadas por tamanho, não pela ordem em que foram gravadas.
      const notas = linhas[0].notas as Array<Record<string, unknown>>;
      linhas[0].notas = notas.map((n) => Object.fromEntries(Object.entries(n).reverse()));
      const r = await reclassificar(lerConfigNotasFiscais(config), AGORA);
      expect(r).toEqual({ mudadas: 0, apagadas: 0 });
    });

    it("⚠ quem ficou fora sem os itens lidos e agora entraria é apagado, para a rodada ler de novo", async () => {
      config = { ...config, clientes: [{ clienteId: 970, regra: "nunca" }] };
      pagas = [cobranca(900, [1])];
      await rodar();
      const r = await reclassificar(lerConfigNotasFiscais({ codigos: { "10": "03.03.02" } }), AGORA);
      expect(r).toEqual({ mudadas: 0, apagadas: 1 });
      expect(linhas).toEqual([]);

      config = { codigos: { "10": "03.03.02" } };
      reiniciarRelogioDasNotas();
      await rodar();
      expect(linhas[0]).toMatchObject({ cobrancaId: 900, situacao: "PRONTA" });
    });
  });
});

describe("o aviso do Conexa lê UMA cobrança", () => {
  it("⚠ cobrança paga hoje: lê só ela e as vendas, e grava como a rodada gravaria", async () => {
    pagas = [cobranca(900, [1, 2]), cobranca(901, [3])];
    const r = await conferirUmaCobranca(900, AGORA);
    expect(r).toMatchObject({ acao: "gravada", situacao: "PRONTA" });
    expect(chamadas).toEqual(["cobranca:900", "venda:1", "produto:2970", "venda:2", "produto:2880"]);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      cobrancaId: 900,
      evento: "quitada",
      situacao: "PRONTA",
      notas: [expect.objectContaining({ chave: "conexa-900-030302", valorCentavos: 14900 })],
    });
  });

  it("⚠ o resultado é o mesmo que a rodada de 30 min daria para a mesma cobrança", async () => {
    pagas = [cobranca(900, [1, 2])];
    await conferirUmaCobranca(900, AGORA);
    const doAviso = linhas[0];
    linhas = [];
    reiniciarRelogioDasNotas();
    await rodar();
    expect(linhas[0]).toMatchObject({
      evento: doAviso.evento,
      situacao: doAviso.situacao,
      valorCentavos: doAviso.valorCentavos,
      notas: doAviso.notas,
    });
  });

  it("cobrança já registrada não é lida de novo", async () => {
    pagas = [cobranca(900, [1])];
    await conferirUmaCobranca(900, AGORA);
    chamadas = [];
    const r = await conferirUmaCobranca(900, AGORA);
    expect(r.acao).toBe("ja vista");
    expect(chamadas).toEqual([]);
  });

  it("⚠ o aviso pode chegar antes: cobrança ainda em aberto na API não é registrada, e diz que não está paga", async () => {
    emAberto = [cobranca(910, [1], { status: "unpaid", paidAmount: null, paymentDate: null })];
    const r = await conferirUmaCobranca(910, AGORA);
    expect(r).toMatchObject({ acao: "ignorada", naoPaga: true });
    expect(linhas).toHaveLength(0);
    expect(chamadas).toEqual(["cobranca:910"]);
  });

  it("cliente 'antes' com cobrança gerada na janela: grava como 'gerada'", async () => {
    config = { ...config, inicio: "2026-10-01", clientes: [{ clienteId: 980, regra: "antes" }] };
    emAberto = [
      cobranca(920, [1], { customerId: 980, status: "unpaid", paidAmount: null, paymentDate: null, createdAt: "2026-10-05T09:00:00-03:00" }),
    ];
    const r = await conferirUmaCobranca(920, AGORA);
    expect(r).toMatchObject({ acao: "gravada" });
    expect(linhas[0]).toMatchObject({ cobrancaId: 920, evento: "gerada" });
  });

  it("pagamento anterior à janela da conferência é ignorado", async () => {
    pagas = [cobranca(930, [1], { paymentDate: "2026-09-01" })];
    const r = await conferirUmaCobranca(930, AGORA);
    expect(r.acao).toBe("ignorada");
    expect(r.detalhe).toMatch(/anterior à janela/);
    expect(linhas).toHaveLength(0);
  });

  it("número que o Conexa não conhece é ignorado, sem erro", async () => {
    const r = await conferirUmaCobranca(99999, AGORA);
    expect(r).toMatchObject({ acao: "ignorada" });
    expect(r.detalhe).toMatch(/não conhece/);
  });

  it("integração desligada ou Conexa fora: não lê nada", async () => {
    ligada = false;
    expect((await conferirUmaCobranca(900, AGORA)).acao).toBe("desligada");
    ligada = true;
    conexaAberto = false;
    expect((await conferirUmaCobranca(900, AGORA)).acao).toBe("sem conexa");
    expect(chamadas).toEqual([]);
  });

  it("⚠ falha ao ler uma venda não grava a cobrança pela metade", async () => {
    pagas = [cobranca(900, [1, 2])];
    vendaQueFalha = 2;
    const r = await conferirUmaCobranca(900, AGORA);
    expect(r.acao).toBe("falhou");
    expect(linhas).toHaveLength(0);
  });
});
