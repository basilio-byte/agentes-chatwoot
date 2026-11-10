import { describe, expect, it } from "vitest";
import {
  cadastroExistente,
  contratoExistente,
  linkDoClienteNoConexa,
} from "./duplicidade";

describe("cadastroExistente", () => {
  it("só a mesma unidade conta; ativo primeiro, depois o mais antigo", () => {
    expect(cadastroExistente([{ customerId: 9, companyId: 4 }], 3)).toBeNull();
    expect(
      cadastroExistente(
        [
          { customerId: 5977, companyId: 3, isActive: true },
          { customerId: 5976, companyId: 3, isActive: true },
        ],
        3,
      ),
    ).toEqual({ id: 5976, ativo: true });
    expect(
      cadastroExistente(
        [
          { customerId: 10, companyId: 3, isActive: false },
          { customerId: 20, companyId: "3", isActive: true },
        ],
        3,
      ),
    ).toEqual({ id: 20, ativo: true });
    expect(cadastroExistente([{ customerId: 10, companyId: 3, isActive: false }], 3)).toEqual({ id: 10, ativo: false });
  });

  it("sem lista, nada", () => {
    expect(cadastroExistente([], 3)).toBeNull();
  });
});

describe("contratoExistente", () => {
  const ativo = (id: number, planId: number, startDate = "2026-11-10") => ({
    contractId: id,
    planId,
    isActive: true,
    startDate,
  });

  it("acha o contrato ativo do mesmo plano", () => {
    expect(contratoExistente([ativo(12946, 151)], 151)).toEqual({
      id: 12946,
      planoId: 151,
      inicio: "2026-11-10",
    });
  });

  it("⚠ casa pelo PLANO: outro contrato do cliente não barra a venda nova", () => {
    // Cliente com endereço fiscal (151) fechando uma sala (43): legítimo.
    expect(contratoExistente([ativo(12946, 151)], 43)).toBeNull();
  });

  it("contrato encerrado não barra — cliente que volta contrata de novo", () => {
    expect(
      contratoExistente([{ contractId: 1, planId: 151, isActive: false }], 151),
    ).toBeNull();
  });

  it("sem contrato nenhum, não barra", () => {
    expect(contratoExistente([], 151)).toBeNull();
  });

  it("entre dois já duplicados, devolve sempre o mesmo (o mais antigo)", () => {
    const itens = [ativo(12999, 151), ativo(12946, 151)];
    expect(contratoExistente(itens, 151)?.id).toBe(12946);
    expect(contratoExistente([...itens].reverse(), 151)?.id).toBe(12946);
  });

  it("a listagem devolve contractId e o detalhe devolve id", () => {
    expect(contratoExistente([{ id: 77, planId: 151, isActive: true }], 151)?.id).toBe(77);
  });

  it("data com hora junto vira só o dia", () => {
    expect(contratoExistente([ativo(1, 151, "2026-11-10T03:00:00Z")], 151)?.inicio).toBe(
      "2026-11-10",
    );
  });
});

describe("linkDoClienteNoConexa", () => {
  it("monta o mesmo formato do campo CONEXA LINK das tarefas", () => {
    expect(
      linkDoClienteNoConexa("https://seahubcoworking.conexa.app/index.php/api/v2", 5077),
    ).toBe(
      "https://seahubcoworking.conexa.app/index.php?r=vendaRecorrente/gerenciarContratos&idCliente=5077",
    );
  });

  it("URL torta devolve nulo, em vez de um link que não leva a lugar nenhum", () => {
    expect(linkDoClienteNoConexa("nao e url", 1)).toBeNull();
  });
});
