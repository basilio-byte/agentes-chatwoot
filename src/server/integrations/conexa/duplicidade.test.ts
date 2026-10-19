import { describe, expect, it } from "vitest";
import { cadastroExistente } from "./duplicidade";

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
