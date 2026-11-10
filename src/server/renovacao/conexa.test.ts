import { describe, expect, it, vi } from "vitest";

import {
  CONTRATOS_POR_PAGINA,
  PAGINAS_MAXIMAS,
  contratoDaLeva,
  lerContratosAtivos,
} from "./conexa";

/** Um contrato como o Conexa devolve — valores reais do cliente 5060. */
const BRUTO = {
  contractId: 10601,
  customerId: 5060,
  planId: 169,
  paymentFrequency: "Yearly",
  contractSummary: "Seatech - EV - Endereço Fiscal Litoral Anual",
  startDate: "2025-12-01",
  endDate: null,
  isActive: true,
  amount: 1338.62,
  dueDay: 1,
  fidelityDate: "2026-11-30",
  lastContractualReadjustment: { index: "IPCA", date: "2026-10-23", percentage: 4.58 },
};

describe("contratoDaLeva", () => {
  it("lê o que a renovação precisa, inclusive o que formatarContrato descarta", () => {
    expect(contratoDaLeva(BRUTO)).toEqual({
      id: 10601,
      clienteId: 5060,
      fidelidade: "2026-11-30",
      valor: 1338.62,
      periodicidade: "Yearly",
      inicio: "2025-12-01",
      fim: null,
      ativo: true,
      reajusteEm: "2026-10-23",
      reajustePct: 4.58,
      reajusteIndice: "IPCA",
      plano: 169,
      resumo: "Seatech - EV - Endereço Fiscal Litoral Anual",
      diaDeVencimento: 1,
    });
  });

  it("⚠ a listagem devolve contractId e o detalhe devolve id", () => {
    expect(contratoDaLeva({ id: 10636, customerId: 5077 })?.id).toBe(10636);
    expect(contratoDaLeva({ contractId: 10601, customerId: 5060 })?.id).toBe(10601);
  });

  it("contrato sem reajuste não inventa índice nem percentual", () => {
    const c = contratoDaLeva({ ...BRUTO, lastContractualReadjustment: null });
    expect(c).toMatchObject({ reajusteEm: null, reajustePct: null, reajusteIndice: null });
  });

  it("⚠ sem o campo isActive conta como ATIVO: tratar como encerrado perderia a leva dele", () => {
    const { isActive: _, ...semCampo } = BRUTO;
    expect(contratoDaLeva(semCampo)?.ativo).toBe(true);
    expect(contratoDaLeva({ ...BRUTO, isActive: false })?.ativo).toBe(false);
  });

  it("data com hora junto vira só o dia, e data torta vira nulo", () => {
    expect(contratoDaLeva({ ...BRUTO, fidelityDate: "2026-11-30T03:00:00Z" })?.fidelidade).toBe(
      "2026-11-30",
    );
    expect(contratoDaLeva({ ...BRUTO, fidelityDate: "30/11/2026" })?.fidelidade).toBeNull();
    expect(contratoDaLeva({ ...BRUTO, fidelityDate: "" })?.fidelidade).toBeNull();
  });

  it("sem id ou sem cliente, descarta em vez de montar um contrato pela metade", () => {
    expect(contratoDaLeva({ customerId: 5060 })).toBeNull();
    expect(contratoDaLeva({ contractId: 10601 })).toBeNull();
  });
});

describe("lerContratosAtivos", () => {
  function clienteFalso(paginas: Record<string, unknown>[][]) {
    const chamadas: Array<Record<string, unknown>> = [];
    return {
      chamadas,
      cliente: {
        listarContratos: vi.fn(async (filtros: Record<string, unknown>) => {
          chamadas.push(filtros);
          const i = Number(filtros.offset ?? 0) / CONTRATOS_POR_PAGINA;
          return { itens: paginas[i] ?? [], temMais: i < paginas.length - 1 };
        }),
      },
    };
  }

  it("percorre as páginas e junta tudo, só com os ativos", async () => {
    const { cliente, chamadas } = clienteFalso([
      [BRUTO, { ...BRUTO, contractId: 2, customerId: 2 }],
      [{ ...BRUTO, contractId: 3, customerId: 3 }],
    ]);

    const leitura = await lerContratosAtivos(cliente, null);

    expect(leitura.contratos.map((c) => c.id)).toEqual([10601, 2, 3]);
    expect(leitura.completa).toBe(true);
    expect(leitura.paginas).toBe(2);
    expect(chamadas).toEqual([
      { isActive: 1, limit: CONTRATOS_POR_PAGINA, offset: 0 },
      { isActive: 1, limit: CONTRATOS_POR_PAGINA, offset: CONTRATOS_POR_PAGINA },
    ]);
  });

  it("⚠ leitura cortada no teto avisa que está incompleta, em vez de parecer inteira", async () => {
    const paginas = Array.from({ length: PAGINAS_MAXIMAS + 5 }, (_, i) => [
      { ...BRUTO, contractId: i + 1, customerId: i + 1 },
    ]);
    const { cliente } = clienteFalso(paginas);

    const leitura = await lerContratosAtivos(cliente, null);

    expect(leitura.completa).toBe(false);
    expect(leitura.paginas).toBe(PAGINAS_MAXIMAS);
    expect(leitura.contratos).toHaveLength(PAGINAS_MAXIMAS);
  });

  it("uma página só não pede a segunda", async () => {
    const { cliente } = clienteFalso([[BRUTO]]);
    const leitura = await lerContratosAtivos(cliente, null);
    expect(cliente.listarContratos).toHaveBeenCalledTimes(1);
    expect(leitura.completa).toBe(true);
  });
});
