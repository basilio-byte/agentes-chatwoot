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

function leitor(vendas: Record<number, number>) {
  const consultadas: number[] = [];
  return {
    consultadas,
    listarCobrancas: async () => ({ itens: ITENS }),
    obterVenda: async (id: number) => {
      consultadas.push(id);
      if (!(id in vendas)) throw new Error("venda não abre");
      return { contractId: vendas[id] };
    },
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
        listarCobrancas: async () => ({ itens: muitas }),
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

  it("⚠ sem cobrança, NÃO oferece a tela interna como substituta", async () => {
    const r = await linksDoContrato(leitor({}), BASE, 6049, 12948);

    expect(r.linkDePagamentoDoCliente).toBeNull();
    expect(r.avisoSobreOsLinks).toContain("NÃO existe link de pagamento");
    expect(r.avisoSobreOsLinks).toContain("Não use telaDoContratoNoErp no lugar dele");
  });

  it("⚠ leitura que falha não lança: o contrato já foi criado", async () => {
    const r = await linksDoContrato(
      {
        listarCobrancas: async () => {
          throw new Error("conexa caiu");
        },
        obterVenda: async () => ({}),
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
