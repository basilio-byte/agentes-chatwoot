import { describe, expect, it } from "vitest";
import {
  acrescentarAnotacao,
  carimboDaAnotacao,
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

/**
 * O carimbo é a única coisa que separa "o robô afirmou isso" de "um colega
 * afirmou isso", no meio de um campo onde a equipe comercial escreve à mão.
 * Origem ERRADA é pior que origem nenhuma: manda quem cobra ou renova procurar
 * um atendimento que nunca existiu, e `notes` não tem desfazer.
 */
describe("carimboDaAnotacao", () => {
  const AGORA = { data: "09/09/2026", hora: "14:32" };

  it("veio de uma conversa do Chatwoot: continua dizendo atendimento", () => {
    // Aqui a palavra é verdadeira e é útil — quem ler acha a conversa em
    // /conversas e confere o que foi combinado.
    expect(carimboDaAnotacao(AGORA, { chatwootConversationId: 4812 })).toBe(
      "09/09/2026 14:32 · atendimento",
    );
  });

  it("sem conversa nenhuma, NÃO promete um atendimento", () => {
    // ⚠ Este é o caso da mesa do agente — `AgentRun.conversationId` fica nulo e
    // não há conversa. Mas também é o do gatilho HTTP e o do agendamento: o
    // `ToolContext` só sabe dizer se há conversa do Chatwoot, então a palavra
    // tem de ser verdadeira nos três.
    for (const semConversa of [
      {},
      { chatwootConversationId: undefined },
      { chatwootConversationId: null },
    ]) {
      const carimbo = carimboDaAnotacao(AGORA, semConversa);
      expect(carimbo).toBe("09/09/2026 14:32 · robô");
      expect(carimbo).not.toContain("atendimento");
    }
  });

  it("a data e a hora vão como recebidas, no formato daqui", () => {
    // ⚠ O container roda em UTC; quem resolve o fuso é `agoraEmSaoPaulo`. Esta
    // função não pode reformatar nada — só compor.
    expect(carimboDaAnotacao({ data: "01/12/2026", hora: "08:05" }, {})).toBe(
      "01/12/2026 08:05 · robô",
    );
  });

  it("a linha que cai no ERP não afirma origem que não houve", () => {
    // Ponta a ponta, porque é o texto inteiro que uma pessoa lê na tela do
    // Conexa — e é a composição dos dois que já saiu errada uma vez.
    const humano = "Cliente pediu nota fiscal separada por unidade.";

    const r = acrescentarAnotacao(
      humano,
      "CNPJ conferido: ativo na Receita.",
      carimboDaAnotacao(AGORA, {}),
    );

    expect(r.texto).toBe(
      `${humano}\n[09/09/2026 14:32 · robô] CNPJ conferido: ativo na Receita.`,
    );
  });
});
