import { describe, expect, it } from "vitest";

import {
  cobrancaDoContrato,
  cobrancaDoContratoNoConexa,
  cobrancaPaga,
  lerCobrancas,
  linksDoContrato,
  VENDAS_CONSULTADAS,
} from "./cobranca-do-contrato";

const BASE = "https://seahubcoworking.conexa.app/index.php/api/v2";

/** Cobranças como a listagem do Conexa as devolve. */
const ITENS = [
  { chargeId: 32132, status: "unpaid", chargeUrl: "https://x/fatura?id=aaa", salesIds: [66423] },
  { chargeId: 32200, status: "unpaid", chargeUrl: "https://x/fatura?id=bbb", salesIds: [70000] },
];

/**
 * `vendas` liga id da venda → contrato. `doCliente` é o que a listagem de
 * vendas devolve (o caminho novo, do faturamento da primeira cobrança).
 */
function leitor(
  vendas: Record<number, number>,
  opcoes: {
    doCliente?: Array<{ id: number; contractId: number }>;
    cobrancasPendentes?: Array<Record<string, unknown>>;
  } = {},
) {
  const consultadas: number[] = [];
  const criadas: Array<{ salesIds: number[]; dueDate?: string }> = [];
  return {
    consultadas,
    criadas,
    listarCobrancas: async (f: { status?: string } = {}) => ({
      // A busca por cobrança PENDENTE é a trava anti-duplicidade; a sem filtro
      // é a que amarra cobrança → venda → contrato.
      itens: f?.status ? (opcoes.cobrancasPendentes ?? []) : ITENS,
      temMais: false,
    }),
    obterVenda: async (id: number) => {
      consultadas.push(id);
      if (!(id in vendas)) throw new Error("venda não abre");
      return { contractId: vendas[id] };
    },
    listarVendas: async () => ({
      itens: (opcoes.doCliente ?? []).map((v) => ({ id: v.id, contractId: v.contractId })),
      temMais: false,
    }),
    criarCobranca: async (dados: { salesIds: number[]; dueDate?: string }) => {
      criadas.push(dados);
      return { id: 40001 };
    },
    obterCobranca: async () => ({ chargeUrl: "https://x/fatura?id=nova" }),
  };
}

describe("cobrancaDoContrato", () => {
  it("amarra pela venda, não pela data: duas cobranças abertas do mesmo cliente", () => {
    const cobrancas = lerCobrancas(ITENS);
    expect(cobrancaDoContrato(cobrancas, new Set([66423]))?.id).toBe(32132);
    expect(cobrancaDoContrato(cobrancas, new Set([70000]))?.id).toBe(32200);
  });

  it("com duas do mesmo contrato, vale a mais antiga — é a primeira a pagar", () => {
    const cobrancas = lerCobrancas(ITENS);
    expect(cobrancaDoContrato(cobrancas, new Set([66423, 70000]))?.id).toBe(32132);
  });

  it("nenhuma venda do contrato: nada", () => {
    expect(cobrancaDoContrato(lerCobrancas(ITENS), new Set([1]))).toBeNull();
  });
});

describe("cobrancaPaga", () => {
  it("só `paid` conta", () => {
    expect(cobrancaPaga("paid")).toBe(true);
    expect(cobrancaPaga("unpaid")).toBe(false);
    expect(cobrancaPaga("billed")).toBe(false);
    expect(cobrancaPaga(null)).toBe(false);
  });
});

describe("cobrancaDoContratoNoConexa", () => {
  it("acha a cobrança do contrato pedido", async () => {
    const c = leitor({ 66423: 12948, 70000: 12000 });
    const achada = await cobrancaDoContratoNoConexa(c, 6049, 12948);
    expect(achada?.id).toBe(32132);
    expect(achada?.faturaUrl).toBe("https://x/fatura?id=aaa");
  });

  it("venda que não abre não derruba a busca", async () => {
    const c = leitor({ 70000: 12948 });
    expect((await cobrancaDoContratoNoConexa(c, 6049, 12948))?.id).toBe(32200);
  });

  it("não consulta venda além do teto", async () => {
    const muitas = Array.from({ length: 30 }, (_, i) => ({
      chargeId: 1000 + i,
      status: "unpaid",
      chargeUrl: null,
      salesIds: [i + 1],
    }));
    const consultadas: number[] = [];
    await cobrancaDoContratoNoConexa(
      {
        listarCobrancas: async () => ({ itens: muitas, temMais: false }),
        obterVenda: async (id: number) => {
          consultadas.push(id);
          return { contractId: 0 };
        },
      },
      6049,
      12948,
    );
    expect(consultadas).toHaveLength(VENDAS_CONSULTADAS);
  });
});

/**
 * O defeito de 10/11/2026: o comentário da task saiu com a tela interna do ERP
 * anunciada como link de pagamento.
 */
describe("linksDoContrato", () => {
  it("separa o link do cliente da tela interna, e diz qual é qual", async () => {
    const r = await linksDoContrato(leitor({ 66423: 12948 }), BASE, 6049, 12948);

    expect(r.linkDePagamentoDoCliente).toBe("https://x/fatura?id=aaa");
    expect(r.telaDoContratoNoErp).toContain("gerenciarContratos&idCliente=6049");
    expect(r.avisoSobreOsLinks).toContain("nunca mande ao cliente");
  });

  it("⚠ sem cobrança e sem venda ainda, NÃO oferece a tela interna como substituta", async () => {
    const r = await linksDoContrato(leitor({}), BASE, 6049, 12948);

    expect(r.linkDePagamentoDoCliente).toBeNull();
    expect(r.primeiraCobranca).toBe("semVenda");
    expect(r.avisoSobreOsLinks).toContain("Não use telaDoContratoNoErp no lugar dele");
  });

  /**
   * O defeito de 11/11/2026: o contrato nascia sem cobrança, e o cliente não
   * tinha como pagar. O Conexa gera a venda sozinho; a cobrança é outro passo.
   */
  it("⚠⚠ sem cobrança mas COM a venda do contrato, gera a primeira cobrança", async () => {
    const c = leitor({}, { doCliente: [{ id: 99001, contractId: 12948 }] });

    const r = await linksDoContrato(c, BASE, 6049, 12948, new Date("2026-11-11T12:00:00Z"));

    expect(r.primeiraCobranca).toBe("criada");
    expect(r.linkDePagamentoDoCliente).toBe("https://x/fatura?id=nova");
    expect(c.criadas).toEqual([{ salesIds: [99001], dueDate: "2026-11-14" }]);
  });

  it("⚠ não cobra de novo quando a venda já tem cobrança pendente", async () => {
    const c = leitor(
      {},
      {
        doCliente: [{ id: 99001, contractId: 12948 }],
        cobrancasPendentes: [
          { chargeId: 32953, salesIds: [99001], chargeUrl: "https://x/fatura?id=velha" },
        ],
      },
    );

    const r = await linksDoContrato(c, BASE, 6049, 12948);

    expect(r.primeiraCobranca).toBe("jaExistia");
    expect(r.linkDePagamentoDoCliente).toBe("https://x/fatura?id=velha");
    expect(c.criadas).toEqual([]);
  });

  it("venda de OUTRO contrato do mesmo cliente não é faturada", async () => {
    const c = leitor({}, { doCliente: [{ id: 98000, contractId: 12000 }] });

    const r = await linksDoContrato(c, BASE, 6049, 12948);

    expect(r.primeiraCobranca).toBe("semVenda");
    expect(c.criadas).toEqual([]);
  });

  it("⚠ leitura que falha não lança: o contrato já foi criado", async () => {
    const r = await linksDoContrato(
      {
        listarCobrancas: async (): Promise<{ itens: Record<string, unknown>[]; temMais: boolean }> => {
          throw new Error("conexa caiu");
        },
        obterVenda: async () => ({}),
        listarVendas: async (): Promise<{ itens: Record<string, unknown>[]; temMais: boolean }> => {
          throw new Error("conexa caiu");
        },
        criarCobranca: async () => ({ id: 0 }),
        obterCobranca: async () => ({}),
      },
      BASE,
      6049,
      12948,
    );

    expect(r.linkDePagamentoDoCliente).toBeNull();
    expect(r.telaDoContratoNoErp).toContain("idCliente=6049");
  });

  it("não devolve mais um campo chamado `link`, que era a isca", async () => {
    const r = await linksDoContrato(leitor({ 66423: 12948 }), BASE, 6049, 12948);
    expect("link" in r).toBe(false);
  });
});
