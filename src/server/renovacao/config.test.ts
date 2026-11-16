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

  it("o WhatsApp ao cliente ONE nasce desligado, e só o modo exato liga", () => {
    expect(lerConfigRenovacao({}, true).avisarPorWhatsapp).toBe("desligado");
    expect(lerConfigRenovacao({ avisarPorWhatsapp: "sombra" }, true).avisarPorWhatsapp).toBe("sombra");
    expect(lerConfigRenovacao({ avisarPorWhatsapp: "ligado" }, true).avisarPorWhatsapp).toBe("ligado");
    for (const torto of ["LIGADO", true, 1, "sim", null]) {
      expect(lerConfigRenovacao({ avisarPorWhatsapp: torto }, true).avisarPorWhatsapp).toBe("desligado");
    }
  });

  it("⚠ interruptor geral desligado vence o WhatsApp também", () => {
    expect(lerConfigRenovacao({ avisarPorWhatsapp: "ligado" }, false).avisarPorWhatsapp).toBe("desligado");
  });

  it("quem recebe a conversa e o texto são dado da tela: valem mesmo com o geral desligado", () => {
    const c = lerConfigRenovacao(
      { whatsappAtribuirA: " Ana ", whatsappTexto: "Olá {responsavel}, tudo bem? ".padEnd(60, "x") },
      false,
    );
    expect(c.whatsappAtribuirA).toBe("Ana");
    expect(c.whatsappTexto?.startsWith("Olá {responsavel}")).toBe(true);
  });

  it("sem nada gravado, quem recebe é o Felipe e o texto segue o padrão", () => {
    const c = lerConfigRenovacao({}, true);
    expect(c.whatsappAtribuirA).toBe("Felipe");
    expect(c.whatsappTexto).toBeNull();
  });

  it("⚠ texto torto gravado à mão volta ao padrão em vez de ir ao cliente com marcador cru", () => {
    expect(lerConfigRenovacao({ whatsappTexto: "Olá {nome}, tudo bem? ".padEnd(60, "x") }, true).whatsappTexto).toBeNull();
    expect(lerConfigRenovacao({ whatsappTexto: "curto" }, true).whatsappTexto).toBeNull();
    expect(lerConfigRenovacao({ whatsappTexto: 42 }, true).whatsappTexto).toBeNull();
    expect(lerConfigRenovacao({ whatsappAtribuirA: "x".repeat(81) }, true).whatsappAtribuirA).toBe("Felipe");
  });

  it("o token do endereço das datas sobrevive ao interruptor desligado", () => {
    // Desligar não pode apagar o endereço já cadastrado no ClickUp.
    expect(lerConfigRenovacao({ tokenHash: "abc" }, false).tokenHash).toBe("abc");
    expect(lerConfigRenovacao({ tokenHash: "" }, true).tokenHash).toBeNull();
  });
});
