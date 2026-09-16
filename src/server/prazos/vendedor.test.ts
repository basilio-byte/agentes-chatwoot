import { describe, expect, it } from "vitest";
import { opcaoDoVendedor } from "./vendedor";

/** As opções reais do campo VENDEDOR no CRM Comercial, em 16/09/2026. */
const OPCOES = [
  "Ferdinando", "Arthur", "Élisson", "Auto Venda", "Diego", "Regis",
  "Felipe Fragoso", "Duda", "Alan", "Kelly", "Laiza", "Nathã",
];

describe("de quem atende para a opção do VENDEDOR", () => {
  it("⚠ 'Wellen Kelly' é Kelly, não Wellen — é por isso que a regra não é primeiro nome", () => {
    expect(opcaoDoVendedor("Wellen Kelly", OPCOES)).toEqual({ opcao: "Kelly" });
  });

  it("casa pelo primeiro nome quando é ele que está na lista", () => {
    expect(opcaoDoVendedor("Alan Novaes", OPCOES)).toEqual({ opcao: "Alan" });
    expect(opcaoDoVendedor("Diego Sena", OPCOES)).toEqual({ opcao: "Diego" });
  });

  it("acento não atrapalha, nos dois sentidos", () => {
    expect(opcaoDoVendedor("Natha Tinelli", OPCOES)).toEqual({ opcao: "Nathã" });
    expect(opcaoDoVendedor("Élisson de Souza", OPCOES)).toEqual({ opcao: "Élisson" });
  });

  it("opção de duas palavras casa sem virar duas", () => {
    expect(opcaoDoVendedor("Felipe Fragoso", OPCOES)).toEqual({ opcao: "Felipe Fragoso" });
  });

  it("quem não está na lista recusa, e mostra as opções", () => {
    const r = opcaoDoVendedor("Socorro Almeida", OPCOES);
    expect("erro" in r && r.erro).toContain("Nenhuma opção");
    expect("candidatas" in r && r.candidatas).toEqual(OPCOES);
  });

  it("⚠ ambiguidade NÃO vira palpite", () => {
    // Um nome que alcança duas opções não pode escolher sozinho: a venda
    // apareceria no nome de outra pessoa.
    const r = opcaoDoVendedor("Arthur Diego", OPCOES);
    expect("erro" in r && r.erro).toContain("mais de uma opção");
    expect("candidatas" in r && r.candidatas).toEqual(["Arthur", "Diego"]);
  });

  it("palavra de ligação não casa com nada", () => {
    expect(opcaoDoVendedor("de da e", OPCOES)).toMatchObject({
      erro: expect.stringContaining("não tem nome utilizável"),
    });
  });

  it("nome vazio recusa em vez de quebrar", () => {
    expect("erro" in opcaoDoVendedor("", OPCOES)).toBe(true);
  });
});
