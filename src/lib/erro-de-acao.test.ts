import { describe, expect, it } from "vitest";
import { ehFluxoDeControle, ehVersaoDesatualizada } from "./erro-de-acao";

/**
 * Estas duas funções decidem se uma falha de server action é defeito ou não.
 *
 * Erraram nos dois sentidos em produção, em 04/09/2026: o painel tratava
 * `redirect()` como erro (e engolia o login) e tratava aba desatualizada como
 * erro genérico (e mandava "tente de novo", que nunca resolve). O resultado foi
 * um diagnóstico de "problema de armazenamento" para um `F5`.
 */

describe("aba com a build anterior", () => {
  it("reconhece o erro que o Next lança quando a ação não existe mais", () => {
    // O cliente do Next lança `UnrecognizedActionError` ao ver o cabeçalho
    // `x-nextjs-action-not-found`. Casar pelo NOME sobrevive à minificação e a
    // uma renomeação da API `unstable_`.
    const erro = new Error('Server Action "abc" was not found on the server.');
    erro.name = "UnrecognizedActionError";

    expect(ehVersaoDesatualizada(erro)).toBe(true);
  });

  it("não confunde com erro comum", () => {
    expect(ehVersaoDesatualizada(new Error("timeout do banco"))).toBe(false);
    expect(ehVersaoDesatualizada(null)).toBe(false);
    expect(ehVersaoDesatualizada(undefined)).toBe(false);
    expect(ehVersaoDesatualizada("texto solto")).toBe(false);
    // Mensagem parecida, nome diferente: não é o caso, e tratar como se fosse
    // mandaria o operador recarregar em vez de mostrar a causa real.
    expect(
      ehVersaoDesatualizada(new Error("Server Action was not found")),
    ).toBe(false);
  });
});

describe("fluxo de controle do Next", () => {
  it("reconhece redirect e notFound pelo digest", () => {
    // ⚠ Capturar estes foi metade do defeito: `exigirSessao()` chama
    // `redirect("/login")` quando a sessão cai, e o `catch` da tela de
    // execuções virava "tente de novo" — o operador nunca chegava ao login.
    const redirecionar = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;push;/login;307;",
    });
    const naoEncontrado = Object.assign(new Error("NEXT_NOT_FOUND"), {
      digest: "NEXT_NOT_FOUND",
    });

    expect(ehFluxoDeControle(redirecionar)).toBe(true);
    expect(ehFluxoDeControle(naoEncontrado)).toBe(true);
  });

  it("não trata erro de verdade como fluxo de controle", () => {
    // Relançar um erro real em vez de mostrá-lo devolveria o operador ao
    // silêncio que este módulo existe para acabar.
    expect(ehFluxoDeControle(new Error("connection refused"))).toBe(false);
    expect(
      ehFluxoDeControle(Object.assign(new Error("x"), { digest: "abc123" })),
    ).toBe(false);
    expect(ehFluxoDeControle(null)).toBe(false);
  });
});
