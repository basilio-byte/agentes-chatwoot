import { describe, expect, it } from "vitest";
import { UserRole } from "@/generated/prisma/enums";
import { ORDEM_DOS_PAPEIS, PAPEIS, rotuloDoPapel } from "./papeis";

const TODOS = Object.values(UserRole);

describe("catálogo de papéis", () => {
  it("descreve todo papel que existe no banco", () => {
    // Papel novo no enum sem entrada aqui apareceria no seletor sem rótulo e
    // sem descrição — e é essa frase que decide o que se entrega a alguém.
    for (const papel of TODOS) {
      expect(PAPEIS[papel], papel).toBeDefined();
      expect(PAPEIS[papel].rotulo.length).toBeGreaterThan(0);
      expect(PAPEIS[papel].resumo.length).toBeGreaterThan(0);
      expect(PAPEIS[papel].pode.length).toBeGreaterThan(0);
      expect(PAPEIS[papel].naoPode.length).toBeGreaterThan(0);
    }
  });

  it("lista cada papel uma vez só no seletor", () => {
    expect([...ORDEM_DOS_PAPEIS].sort()).toEqual([...TODOS].sort());
  });

  it("vai do menos para o mais privilegiado", () => {
    // A ordem é o que faz quem libera acesso encontrar primeiro a opção mais
    // contida; inverter isso empurraria para o papel mais poderoso.
    expect(ORDEM_DOS_PAPEIS).toEqual([
      UserRole.VIEWER,
      UserRole.ADMIN,
      UserRole.OWNER,
    ]);
  });

  it("cada papel tem uma descrição própria, não a do vizinho", () => {
    // O bug que originou este arquivo: a tela mostrava a descrição do
    // Administrador para os três papéis.
    const resumos = TODOS.map((p) => PAPEIS[p].resumo);
    expect(new Set(resumos).size).toBe(TODOS.length);
  });

  it("só leitura não pode escrever nem gastar", () => {
    const leitura = PAPEIS[UserRole.VIEWER];
    expect(leitura.pode.join(" ")).not.toMatch(/criar|editar|excluir/i);
    expect(leitura.naoPode.join(" ")).toMatch(/playground/i);
  });

  it("rotuloDoPapel devolve o mesmo rótulo do catálogo", () => {
    expect(rotuloDoPapel(UserRole.OWNER)).toBe(PAPEIS[UserRole.OWNER].rotulo);
  });
});
