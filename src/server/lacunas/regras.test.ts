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
  validarResolucao,
} from "./regras";

describe("validarResolucao", () => {
  it("aceita uma frase de verdade e devolve o texto limpo", () => {
    expect(validarResolucao("  Acrescentei o procedimento ao prompt.  ")).toEqual({
      ok: true,
      texto: "Acrescentei o procedimento ao prompt.",
    });
  });

  it("⚠ 'ok', 'feito' e vazio não dizem o que foi feito: recusa", () => {
    for (const texto of ["", "   ", "ok", "feito", "resolvido.", null, undefined]) {
      const r = validarResolucao(texto);
      expect(r.ok).toBe(false);
    }
  });

  it("o mínimo conta caracteres úteis, e não espaços ou quebras", () => {
    expect(validarResolucao("a\n\n\n   b\n   c").ok).toBe(false);
    expect(validarResolucao("conferi o prompt e o playground").ok).toBe(true);
  });

  it("mantém as quebras de linha (até duas seguidas) e tira o espaço sobrando", () => {
    const r = validarResolucao("Passo 1:  ajustei o prompt.\r\n\r\n\r\n\r\nPasso 2: testei.");
    expect(r).toEqual({ ok: true, texto: "Passo 1: ajustei o prompt.\n\nPasso 2: testei." });
  });

  it("⚠ acima do teto RECUSA em vez de cortar: perder o fim do comentário em silêncio seria pior", () => {
    const r = validarResolucao("x".repeat(1001));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro).toContain("1001");
    expect(validarResolucao("x".repeat(1000)).ok).toBe(true);
  });
});

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
