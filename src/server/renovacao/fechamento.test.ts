import { describe, expect, it } from "vitest";

import {
  chaveDoFechamento,
  comentarioDaTrava,
  comentarioDoFechamento,
  destinoDoCiclo,
  lerCobrancasPagas,
  pagouOCicloNovo,
  type CobrancaPaga,
} from "./fechamento";

/**
 * O caso base é o `(2129)` real: contrato mensal de R$ 88,98 (reajustado em
 * 19/11/2025), cobrança "contractual" com DUAS vendas faturadas (88552 e 89662)
 * e pagamento no vencimento. O `(5051)` é o das quatro vendas numa fatura só.
 */

const REAJUSTE = "2026-11-23";

const cobranca = (extra: Partial<CobrancaPaga> = {}): CobrancaPaga => ({
  id: 31571,
  pagaEm: "2026-12-15",
  valorPago: 88.98,
  vendas: [88552, 89662],
  ...extra,
});

const confere = (cobrancas: CobrancaPaga[], extra: { valor?: number; vendas?: number[] } = {}) =>
  pagouOCicloNovo({
    reajusteEm: REAJUSTE,
    valorDoContrato: extra.valor ?? 88.98,
    cobrancas,
    vendasDoContrato: new Set(extra.vendas ?? [88552]),
  });

describe("pagouOCicloNovo", () => {
  it("cobrança paga depois do reajuste, do contrato, cobrindo o valor: fechou", () => {
    const r = confere([cobranca()]);
    expect(r).toEqual({
      pagou: true,
      evidencia: { cobrancaId: 31571, pagaEm: "2026-12-15", valorPago: 88.98 },
    });
  });

  it("juros e multa pagam MAIS que o contrato, e vale", () => {
    expect(confere([cobranca({ valorPago: 91.5 })]).pagou).toBe(true);
  });

  it("⚠ pagamento de ANTES do lote é do valor antigo e não conta", () => {
    const r = confere([cobranca({ pagaEm: "2026-11-15" })]);
    expect(r).toMatchObject({ pagou: false });
    expect((r as { motivo: string }).motivo).toContain("anteriores ao reajuste");
  });

  it("⚠ pagou menos que o valor do contrato (desconto na quitação, parcial): é caso de pessoa", () => {
    const r = confere([cobranca({ valorPago: 85 })]);
    expect(r).toMatchObject({ pagou: false });
    expect((r as { motivo: string }).motivo).toContain("menor que o valor do contrato");
  });

  it("⚠ cobrança de OUTRO contrato do cliente não prova nada", () => {
    const r = confere([cobranca({ vendas: [70001] })]);
    expect(r).toMatchObject({ pagou: false });
    expect((r as { motivo: string }).motivo).toContain("nenhuma cobrança paga deste contrato");
  });

  it("sem cobrança nenhuma, ainda não pagou", () => {
    expect(confere([])).toMatchObject({ pagou: false });
  });

  it("⚠ pagamento sem data não conta (não dá para saber se é do ciclo novo)", () => {
    expect(confere([cobranca({ pagaEm: null })]).pagou).toBe(false);
  });

  it("(5051) a fatura única dos quatro contratos fecha os QUATRO", () => {
    const fatura = cobranca({ id: 40000, valorPago: 417.92, vendas: [1, 2, 3, 4] });
    for (const venda of [1, 2, 3, 4]) {
      const r = pagouOCicloNovo({
        reajusteEm: REAJUSTE,
        valorDoContrato: 104.48,
        cobrancas: [fatura],
        vendasDoContrato: new Set([venda]),
      });
      expect(r.pagou).toBe(true);
    }
  });

  it("com mais de uma cobrança paga, vale a mais antiga que cobre", () => {
    const r = confere([
      cobranca({ id: 31600, pagaEm: "2027-01-15" }),
      cobranca({ id: 31571 }),
    ]);
    expect(r).toMatchObject({ pagou: true, evidencia: { cobrancaId: 31571 } });
  });

  it("a data de pagamento igual à do reajuste vale (o lote e o pagamento no mesmo dia)", () => {
    expect(confere([cobranca({ pagaEm: REAJUSTE })]).pagou).toBe(true);
  });
});

describe("destinoDoCiclo", () => {
  it("endereço, espaço e SeaBox voltam para `ongoing`", () => {
    for (const c of ["Serviços de endereço", "Serviços de espaço", "SeaBox", "Outros serviços", null]) {
      expect(destinoDoCiclo(c)).toBe("ongoing");
    }
  });

  it("sala privativa tem o status dela", () => {
    expect(destinoDoCiclo("Salas privativas")).toBe("ongoing - sala privativa");
  });

  it("⚠ ONE renova para `one`, e isso o sistema não deduz do pagamento: fica com a equipe", () => {
    expect(destinoDoCiclo("ONE")).toBeNull();
  });
});

describe("lerCobrancasPagas", () => {
  it("só entra a cobrança paga, com o valor PAGO (juros e multa) antes do valor de face", () => {
    const r = lerCobrancasPagas([
      { chargeId: 1, status: "paid", paymentDate: "2026-12-15", paidAmount: "91.50", amount: 88.98, salesIds: [10, 11] },
      { chargeId: 2, status: "unpaid", salesIds: [12] },
      { chargeId: 3, status: "paid", paymentDate: "2026-12-16", amount: 100, salesIds: [] },
    ]);
    expect(r).toEqual([
      { id: 1, pagaEm: "2026-12-15", valorPago: 91.5, vendas: [10, 11] },
      { id: 3, pagaEm: "2026-12-16", valorPago: 100, vendas: [] },
    ]);
  });

  it("data torta vira nula, e valor ausente nunca vira zero", () => {
    const [c] = lerCobrancasPagas([{ chargeId: 9, status: "paid", paymentDate: "lixo" }]);
    expect(c.pagaEm).toBeNull();
    expect(c.valorPago).toBeNull();
  });
});

describe("apoios", () => {
  it("a chave da reserva é por contrato e por reajuste", () => {
    expect(chaveDoFechamento(3682, "2026-11-23")).toBe("fechamento:3682:2026-11-23");
  });

  it("o comentário diz quanto, quando, qual cobrança e para onde foi", () => {
    const c = comentarioDoFechamento(
      "ongoing",
      { cobrancaId: 31571, pagaEm: "2026-12-15", valorPago: 88.98 },
      88.98,
    );
    expect(c).toContain("15/12/2026");
    expect(c).toContain("31571");
    expect(c).toContain('"ongoing"');
  });

  it("o aviso da trava manda mover à mão e promete NÃO tentar de novo", () => {
    expect(comentarioDaTrava("ongoing")).toContain("não tenta de novo");
  });
});
