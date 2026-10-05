import { beforeEach, describe, expect, it, vi } from "vitest";

/** A lista de categorias da tela: formato da API, cache e queda do Conexa. */

let aberturas = 0;
let falhar = false;

vi.mock("@/server/integrations/conexa/sistema", () => ({
  abrirConexa: async () => {
    aberturas++;
    if (falhar) return { erro: "a integração do Conexa está desligada" };
    return {
      cliente: {
        listarCategoriasDeServico: async () => ({
          itens: [
            { serviceCategoryId: 23, name: "SeaBox", companies: [{ id: 3, name: "SEAHUB COWORKING" }], isActive: true },
            { serviceCategoryId: 10, name: "Endereço Fiscal - RN", companies: [], isActive: false },
            { name: "sem id" },
          ],
          temMais: false,
        }),
      },
    };
  },
}));

const { categoriasDoConexa, esquecerCategorias, lerCategoria } = await import("./categorias");

beforeEach(() => {
  esquecerCategorias();
  aberturas = 0;
  falhar = false;
});

describe("categorias de serviço para a tela", () => {
  it("lê o formato de GET /serviceCategories, descarta o que vem sem id e ordena pelo nome", async () => {
    const { categorias, erro } = await categoriasDoConexa(0);
    expect(erro).toBeUndefined();
    expect(categorias).toEqual([
      { id: 10, nome: "Endereço Fiscal - RN", empresas: [], ativa: false },
      { id: 23, nome: "SeaBox", empresas: [{ id: 3, nome: "SEAHUB COWORKING" }], ativa: true },
    ]);
    expect(lerCategoria({ name: "x" })).toBeNull();
  });

  it("guarda a lista por uma hora: a página abre de novo sem chamar o Conexa", async () => {
    await categoriasDoConexa(0);
    await categoriasDoConexa(59 * 60_000);
    expect(aberturas).toBe(1);
    await categoriasDoConexa(61 * 60_000);
    expect(aberturas).toBe(2);
  });

  it("⚠ Conexa fora do ar devolve a última lista boa com o motivo — a tela não perde a tabela", async () => {
    await categoriasDoConexa(0);
    falhar = true;
    const { categorias, erro } = await categoriasDoConexa(2 * 60 * 60_000);
    expect(erro).toMatch(/desligada/);
    expect(categorias).toHaveLength(2);
  });
});
