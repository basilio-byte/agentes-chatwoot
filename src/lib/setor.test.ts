import { describe, expect, it } from "vitest";
import {
  bateComOFiltro,
  chaveDoSetor,
  limparSetor,
  listarSetores,
  reconciliarSetor,
  SEM_SETOR,
} from "./setor";

describe("limparSetor", () => {
  it("tira as pontas e junta os espaços repetidos", () => {
    expect(limparSetor("  Atendimento   ao  cliente ")).toBe("Atendimento ao cliente");
  });

  it("não-texto vira vazio", () => {
    expect(limparSetor(null)).toBe("");
    expect(limparSetor(undefined)).toBe("");
    expect(limparSetor(42)).toBe("");
  });
});

describe("chaveDoSetor", () => {
  it("ignora caixa, acento e espaço sobrando", () => {
    expect(chaveDoSetor("  Operações ")).toBe(chaveDoSetor("operacoes"));
    expect(chaveDoSetor("FINANCEIRO")).toBe(chaveDoSetor("financeiro"));
  });

  it("não confunde setores diferentes", () => {
    expect(chaveDoSetor("Comercial")).not.toBe(chaveDoSetor("Comercial 2"));
  });
});

describe("reconciliarSetor", () => {
  it("vazio vira nulo — é como se tira o setor", () => {
    expect(reconciliarSetor("", ["Comercial"])).toBeNull();
    expect(reconciliarSetor("   ", ["Comercial"])).toBeNull();
    expect(reconciliarSetor(undefined, [])).toBeNull();
  });

  it("reaproveita a grafia que já existe", () => {
    expect(reconciliarSetor("comercial", ["Comercial"])).toBe("Comercial");
    expect(reconciliarSetor("OPERACOES", [null, "Operações"])).toBe("Operações");
  });

  it("setor novo vale como foi escrito, só limpo", () => {
    expect(reconciliarSetor("  Jurídico ", ["Comercial"])).toBe("Jurídico");
  });

  it("ignora existentes nulos ou vazios", () => {
    expect(reconciliarSetor("Marketing", [null, undefined, "", "  "])).toBe("Marketing");
  });
});

describe("listarSetores", () => {
  it("lista cada setor uma vez, em ordem alfabética", () => {
    expect(listarSetores(["Financeiro", "Comercial", null, "Financeiro", ""])).toEqual([
      "Comercial",
      "Financeiro",
    ]);
  });

  it("junta as grafias da mesma área e fica com a mais usada", () => {
    expect(
      listarSetores(["comercial", "Comercial", "Comercial", "COMERCIAL"]),
    ).toEqual(["Comercial"]);
  });

  it("no empate, a ordem é estável (alfabética)", () => {
    const a = listarSetores(["comercial", "Comercial"]);
    const b = listarSetores(["Comercial", "comercial"]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
  });

  it("sem nenhum setor, lista vazia", () => {
    expect(listarSetores([null, undefined, ""])).toEqual([]);
  });
});

describe("bateComOFiltro", () => {
  it("sem filtro, tudo passa", () => {
    expect(bateComOFiltro("Comercial", "")).toBe(true);
    expect(bateComOFiltro(null, null)).toBe(true);
  });

  it("filtro por setor compara sem caixa nem acento", () => {
    expect(bateComOFiltro("Operações", "operacoes")).toBe(true);
    expect(bateComOFiltro("Comercial", "Financeiro")).toBe(false);
  });

  it("'sem setor' pega só quem não tem", () => {
    expect(bateComOFiltro(null, SEM_SETOR)).toBe(true);
    expect(bateComOFiltro("  ", SEM_SETOR)).toBe(true);
    expect(bateComOFiltro("Comercial", SEM_SETOR)).toBe(false);
  });

  it("quem não tem setor não passa por um setor", () => {
    expect(bateComOFiltro(null, "Comercial")).toBe(false);
  });
});
