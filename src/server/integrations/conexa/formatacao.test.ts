import { describe, expect, it } from "vitest";
import {
  acrescentarAnotacao,
  TETO_DE_OBSERVACOES,
} from "./formatacao";

/**
 * `acrescentarAnotacao` é onde texto escrito por gente se perde, se alguém
 * errar. O campo `notes` do Conexa é ÚNICO e o `PATCH` substitui — a equipe
 * comercial escreve ali à mão, e não há desfazer. Por isso a função é pura e
 * tem teste de mesa, como `campos.ts` do ClickUp.
 */

describe("acrescentarAnotacao", () => {
  const CARIMBO = "09/09/2026 14:32 · atendimento";

  it("PRESERVA o que já estava escrito", () => {
    // ⚠ É a razão desta função existir. `notes` é um campo único e o PATCH
    // substitui: um `atualizarCliente({ notes })` ingênuo apagaria o que a
    // equipe comercial escreveu à mão, sem erro e sem desfazer.
    const humano = "Cliente pediu nota fiscal separada por unidade.\nFalar com o Marcos antes de renovar.";

    const r = acrescentarAnotacao(humano, "Reserva de auditório confirmada.", CARIMBO);

    expect(r.texto.startsWith(humano)).toBe(true);
    expect(r.texto).toContain("Cliente pediu nota fiscal separada por unidade.");
    expect(r.texto).toContain("Falar com o Marcos antes de renovar.");
  });

  it("marca a linha nova com data e origem", () => {
    // Anotação sem origem, no meio de texto escrito por gente, é
    // indistinguível de alguém da equipe tendo afirmado aquilo.
    const r = acrescentarAnotacao("nota antiga", "Confirmou o CPF.", CARIMBO);

    expect(r.texto).toBe("nota antiga\n[09/09/2026 14:32 · atendimento] Confirmou o CPF.");
  });

  it("campo vazio não ganha linha em branco na frente", () => {
    for (const vazio of ["", null, undefined, "   "]) {
      const r = acrescentarAnotacao(vazio, "Primeira anotação.", CARIMBO);
      expect(r.texto.startsWith("[")).toBe(true);
      expect(r.texto).not.toContain("\n\n");
    }
  });

  it("não deixa o espaço em branco do fim virar linha extra a cada anotação", () => {
    // Sem o `trimEnd`, uma observação terminada em "\n" ganharia uma linha
    // vazia por anotação, e o campo viraria uma escada.
    const r = acrescentarAnotacao("texto humano\n\n  ", "Nova.", CARIMBO);

    expect(r.texto).toBe("texto humano\n[09/09/2026 14:32 · atendimento] Nova.");
  });

  it("avisa quando o campo passou do teto, sem cortar nada", () => {
    // Cortar destruiria justamente o texto humano que este caminho preserva.
    // Quem decide é a tool, que recusa e manda uma pessoa limpar.
    const enorme = "x".repeat(TETO_DE_OBSERVACOES);

    const r = acrescentarAnotacao(enorme, "mais uma", CARIMBO);

    expect(r.excedeu).toBe(true);
    expect(r.tamanho).toBeGreaterThan(TETO_DE_OBSERVACOES);
    expect(r.texto).toContain(enorme);
  });

  it("dentro do teto não acusa nada", () => {
    const r = acrescentarAnotacao("curto", "também curto", CARIMBO);
    expect(r.excedeu).toBe(false);
  });
});
