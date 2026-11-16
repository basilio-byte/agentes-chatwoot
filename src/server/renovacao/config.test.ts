import { describe, expect, it } from "vitest";

import { CONFIG_PADRAO, lerConfigRenovacao } from "./config";

describe("lerConfigRenovacao", () => {
  it("sem nada gravado, tudo desligado", () => {
    expect(lerConfigRenovacao(null, true)).toEqual(CONFIG_PADRAO);
    expect(lerConfigRenovacao({}, true)).toEqual(CONFIG_PADRAO);
    expect(lerConfigRenovacao(undefined, false)).toEqual(CONFIG_PADRAO);
  });

  it("⚠ interruptor geral desligado vence as chaves de cada parte", () => {
    const c = lerConfigRenovacao(
      { moverParaNotificacao: true, fecharNoPagamento: true, avancarDatas: "ligado" },
      false,
    );
    expect(c.moverParaNotificacao).toBe(false);
    expect(c.fecharNoPagamento).toBe(false);
    expect(c.avancarDatas).toBe("desligado");
  });

  it("com o geral ligado, cada parte vale pela própria chave", () => {
    const c = lerConfigRenovacao(
      { moverParaNotificacao: true, fecharNoPagamento: false, avancarDatas: "sombra" },
      true,
    );
    expect(c).toMatchObject({
      moverParaNotificacao: true,
      fecharNoPagamento: false,
      avancarDatas: "sombra",
    });
  });

  it("⚠ só `true` de verdade liga: texto, número e valor torto ficam desligados", () => {
    const c = lerConfigRenovacao(
      { moverParaNotificacao: "true", fecharNoPagamento: 1, avancarDatas: "LIGADO" },
      true,
    );
    expect(c.moverParaNotificacao).toBe(false);
    expect(c.fecharNoPagamento).toBe(false);
    expect(c.avancarDatas).toBe("desligado");
  });

  it("o token do endereço das datas sobrevive ao interruptor desligado", () => {
    // Desligar não pode apagar o endereço já cadastrado no ClickUp.
    expect(lerConfigRenovacao({ tokenHash: "abc" }, false).tokenHash).toBe("abc");
    expect(lerConfigRenovacao({ tokenHash: "" }, true).tokenHash).toBeNull();
  });
});
