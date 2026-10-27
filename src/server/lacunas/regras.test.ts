import { describe, expect, it } from "vitest";
import { TipoDeLacuna } from "@/generated/prisma/enums";
import {
  CAUSAS,
  O_QUE_FORNECER,
  ROTULO_DO_TIPO,
  TETO_DO_TEXTO,
  detalheVazio,
  limparTexto,
  ocultarDadosPessoais,
  tipoDaCausa,
} from "./regras";

describe("tipoDaCausa", () => {
  it("as três incapacidades viram lacuna, cada uma no seu tipo", () => {
    expect(tipoDaCausa("falta_de_instrucao")).toBe(TipoDeLacuna.FALTA_INSTRUCAO);
    expect(tipoDaCausa("falta_de_ferramenta")).toBe(TipoDeLacuna.FALTA_FERRAMENTA);
    expect(tipoDaCausa("nao_entendi")).toBe(TipoDeLacuna.NAO_ENTENDI);
  });

  it("pedido do cliente NÃO é lacuna: o agente fez o que devia", () => {
    expect(tipoDaCausa("pedido_do_cliente")).toBeNull();
  });

  it("só uma causa fica de fora do relatório", () => {
    const fora = CAUSAS.filter((c) => tipoDaCausa(c) === null);
    expect(fora).toEqual(["pedido_do_cliente"]);
  });
});

describe("rótulos", () => {
  it("todo tipo do banco tem rótulo e orientação — tipo novo sem texto quebra aqui", () => {
    for (const tipo of Object.values(TipoDeLacuna)) {
      expect(ROTULO_DO_TIPO[tipo].length).toBeGreaterThan(3);
      expect(O_QUE_FORNECER[tipo].length).toBeGreaterThan(10);
    }
  });
});

describe("limparTexto", () => {
  it("colapsa espaço e quebra de linha, e apara as pontas", () => {
    expect(limparTexto("  não sei\n\n  o preço   da sala  ")).toBe(
      "não sei o preço da sala",
    );
  });

  it("não corta o que cabe no teto", () => {
    const texto = "a".repeat(TETO_DO_TEXTO);
    expect(limparTexto(texto)).toBe(texto);
  });

  it("corta o que passa do teto e AVISA com reticências", () => {
    const resultado = limparTexto("palavra ".repeat(200));
    expect(resultado.length).toBeLessThanOrEqual(TETO_DO_TEXTO);
    expect(resultado.endsWith("…")).toBe(true);
  });
});

describe("detalheVazio", () => {
  it("barra o que não diz nada", () => {
    expect(detalheVazio(undefined)).toBe(true);
    expect(detalheVazio("")).toBe(true);
    expect(detalheVazio("   \n ")).toBe(true);
    expect(detalheVazio("n/a")).toBe(true);
    expect(detalheVazio("-")).toBe(true);
  });

  it("deixa passar uma frase de verdade", () => {
    expect(detalheVazio("Não há preço de sala para 20 pessoas")).toBe(false);
  });
});

describe("ocultarDadosPessoais", () => {
  it("tira e-mail", () => {
    expect(ocultarDadosPessoais("o cliente maria@exemplo.com pediu nota")).toBe(
      "o cliente [e-mail] pediu nota",
    );
  });

  it("tira telefone, CPF e CNPJ em qualquer formatação", () => {
    expect(ocultarDadosPessoais("ligar para (84) 99999-0000")).toBe("ligar para [número]");
    expect(ocultarDadosPessoais("telefone 84999990000")).toBe("telefone [número]");
    expect(ocultarDadosPessoais("CPF 123.456.789-00 não confere")).toBe(
      "CPF [número] não confere",
    );
    expect(ocultarDadosPessoais("CNPJ 12.345.678/0001-90")).toBe("CNPJ [número]");
  });

  it("deixa data e quantidade, que não identificam ninguém", () => {
    expect(ocultarDadosPessoais("sala para 20 pessoas em 27/10/2026")).toBe(
      "sala para 20 pessoas em 27/10/2026",
    );
    expect(ocultarDadosPessoais("das 14:00 às 18:00")).toBe("das 14:00 às 18:00");
  });
});
