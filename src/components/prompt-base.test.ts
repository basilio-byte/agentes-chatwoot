import { describe, expect, it } from "vitest";
import { PROMPT_BASE } from "./agente-form";
import { NUCLEO, caudaDeConversa } from "@/server/agents/conduta";

/**
 * O prompt-semente tem de CARREGAR as regras gerais, e ficar em dia com o bloco.
 *
 * ⚠ A redundância é deliberada e é decisão do usuário: as regras gerais vão
 * duas vezes no prompt de um agente novo — uma escrita neste texto, outra
 * injetada pelo `blocoDeConduta`. Ele pediu isso três vezes, terminando em "as
 * regras gerais devem aparecer dentro do prompt do agente, sem seção nova".
 *
 * O campo de prompt é onde ele lê e edita o agente; regra que só existe
 * injetada é regra que ele não vê nem controla. Um exemplo completo ensina o
 * que escrever, um esqueleto ensina a deixar em branco.
 *
 * O que estes testes evitam é o defeito REAL que já aconteceu: em 24/08/2026 as
 * regras mudaram no bloco injetado e ninguém releu o exemplo, que por um mês
 * seguiu prometendo coisas noutra redação. Aqui não se trava o texto palavra a
 * palavra — isso engessaria a escrita — e sim que cada assunto do bloco tenha
 * contraparte no exemplo.
 */

/** Cada assunto do bloco e a marca que prova que o exemplo o cobre. */
const ASSUNTOS = [
  { assunto: "idioma (regra 1)", marca: /português do brasil/i },
  { assunto: "não inventar (regra 2)", marca: /não vale como fato sobre a seahub/i },
  { assunto: "fontes permitidas (regra 2)", marca: /duas fontes/i },
  { assunto: "data vem do sistema (regra 3)", marca: /chegam do sistema/i },
  { assunto: "só afirmar o que aconteceu (regra 4)", marca: /devolver sucesso/i },
  { assunto: "escopo (regra 5)", marca: /não é com você/i },
  { assunto: "parar na dúvida (regra 6)", marca: /na dúvida, pare/i },
  { assunto: "formato da conversa (cauda)", marca: /três parágrafos/i },
];

describe("o prompt-semente carrega as regras gerais", () => {
  it("cobre cada assunto do bloco injetado", () => {
    for (const { assunto, marca } of ASSUNTOS) {
      expect(
        PROMPT_BASE,
        `o exemplo deixou de cobrir ${assunto} — se o bloco mudou, atualize os dois`,
      ).toMatch(marca);
    }
  });

  it("continua sendo um prompt de agente, não uma cópia do bloco", () => {
    // Se alguém colar o bloco inteiro aqui, o exemplo deixa de ensinar: o
    // operador precisa ver ASSUNTO e TOM — as duas coisas que só ele sabe —
    // junto das regras, não uma segunda via do texto do sistema.
    expect(PROMPT_BASE).toContain("O QUE É COM VOCÊ");
    expect(PROMPT_BASE).toContain("O QUE NÃO É COM VOCÊ");
    expect(PROMPT_BASE).toContain("COMO VOCÊ SE APRESENTA");
    expect(PROMPT_BASE).not.toContain("--- REGRAS DA CASA ---");
    expect(PROMPT_BASE).not.toContain(NUCLEO);
    expect(PROMPT_BASE).not.toContain(caudaDeConversa(true));
  });

  it("cabe no campo sem virar parede de texto", () => {
    // O campo tem dez linhas visíveis. Um exemplo que precise de rolagem para
    // ser lido inteiro deixa de ser lido — e aí não ensina nada.
    const linhas = PROMPT_BASE.split("\n").length;
    expect(linhas, `${linhas} linhas é longo demais para um exemplo`).toBeLessThan(
      32,
    );
  });

  it("não manda o agente dizer o próprio nome", () => {
    // O nome real só chega pelo roster, que é string vazia quando não há
    // colegas com descrição de roteamento — ou seja, no primeiro agente. Ordem
    // que o prompt não tem como cumprir vira nome inventado, e diferente a cada
    // conversa: exatamente o que a regra 2 proíbe.
    expect(PROMPT_BASE.toLowerCase()).not.toContain("seu nome");
    expect(PROMPT_BASE.toLowerCase()).not.toContain("diga que você é a");
  });
});
