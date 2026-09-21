import { describe, expect, it } from "vitest";
import { escolherSolicitante, pessoaDaApi } from "./solicitante";

describe("pessoaDaApi", () => {
  it("o id vem de personId ou de id", () => {
    expect(pessoaDaApi({ personId: 3, name: "A" })).toEqual({ id: 3, nome: "A" });
    expect(pessoaDaApi({ id: 4 })).toEqual({ id: 4 });
  });

  it("lê a marca de inativa em booleano ou número", () => {
    expect(pessoaDaApi({ id: 1, isActive: false }).ativa).toBe(false);
    expect(pessoaDaApi({ id: 1, isActive: 0 }).ativa).toBe(false);
    expect(pessoaDaApi({ id: 1 }).ativa).toBeUndefined();
  });
});

describe("escolherSolicitante", () => {
  it("uma ativa, lista inteira: é ela", () => {
    expect(escolherSolicitante([{ id: 7 }], true)).toEqual({ tipo: "uma", id: 7 });
  });

  it("sem a marca de ativa conta como ativa — recusar por falta do campo travaria toda reserva", () => {
    expect(escolherSolicitante([{ id: 7, ativa: false }, { id: 8 }], true)).toEqual({ tipo: "uma", id: 8 });
  });

  it("nenhuma ativa com lista inteira: nenhuma", () => {
    expect(escolherSolicitante([{ id: 7, ativa: false }], true)).toEqual({ tipo: "nenhuma" });
  });

  it("⚠ mais de uma, ou lista cortada: devolve as opções em vez de escolher", () => {
    expect(escolherSolicitante([{ id: 7, nome: "A" }, { id: 8 }], true)).toEqual({
      tipo: "varias",
      opcoes: [{ id: 7, nome: "A" }, { id: 8 }],
      listaCompleta: true,
    });
    expect(escolherSolicitante([{ id: 7 }], false)).toMatchObject({ tipo: "varias", listaCompleta: false });
    expect(escolherSolicitante([], false)).toMatchObject({ tipo: "varias", opcoes: [] });
  });

  it("id que não é inteiro positivo não é pessoa", () => {
    expect(escolherSolicitante([{ id: Number.NaN }, { id: 9 }], true)).toEqual({ tipo: "uma", id: 9 });
  });
});
