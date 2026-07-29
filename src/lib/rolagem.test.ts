import { describe, expect, it } from "vitest";
import { estaNoFim, MARGEM_DO_FIM } from "./rolagem";

/** Caixa de 400px de altura com 1000px de conteúdo: dá 600px de rolagem. */
const caixa = (scrollTop: number) => ({
  scrollTop,
  scrollHeight: 1000,
  clientHeight: 400,
});

describe("rolagem grudada no fim", () => {
  it("no fim exato conta como fim", () => {
    expect(estaNoFim(caixa(600))).toBe(true);
  });

  it("dentro da margem ainda conta — subpixel e rolagem suave param antes", () => {
    expect(estaNoFim(caixa(600 - MARGEM_DO_FIM))).toBe(true);
    expect(estaNoFim(caixa(599))).toBe(true);
  });

  it("um pixel acima da margem já solta", () => {
    expect(estaNoFim(caixa(600 - MARGEM_DO_FIM - 1))).toBe(false);
  });

  it("quem subiu para reler não é arrastado de volta", () => {
    expect(estaNoFim(caixa(0))).toBe(false);
    expect(estaNoFim(caixa(120))).toBe(false);
  });

  it("conteúdo menor que a caixa está sempre no fim", () => {
    // Conversa curta não rola: sem isto, o primeiro turno já soltaria o grude.
    expect(estaNoFim({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 })).toBe(
      true,
    );
  });

  it("respeita margem customizada", () => {
    expect(estaNoFim(caixa(590), 0)).toBe(false);
    expect(estaNoFim(caixa(590), 10)).toBe(true);
  });
});
