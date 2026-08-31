import { describe, expect, it } from "vitest";
import { PROMPT_BASE } from "./agente-form";
import { NUCLEO, caudaDeConversa } from "@/server/agents/conduta";

/**
 * O prompt-semente não pode repetir o bloco que o sistema injeta.
 *
 * Este arquivo existe por um defeito real: as regras de comportamento saíram do
 * `PROMPT_BASE` para o `blocoDeConduta` em 24/08/2026, mas o texto-semente
 * continuou dizendo "responde o que sabe com certeza", "não concede desconto" e
 * "não promete prazo sem confirmar" — as três já garantidas pelas regras 2 e 5.
 *
 * Ficou assim por um mês porque nada olhava os dois textos juntos. O usuário
 * viu depois de um deploy e leu como "as regras antigas voltaram": ele estava
 * olhando o campo logo abaixo da dica que promete que essas regras "não
 * precisam (nem devem) ser repetidas neste campo".
 *
 * A divisão que estes testes travam: o bloco injetado descreve COMPORTAMENTO;
 * o prompt-semente nomeia ASSUNTO e TOM — a única parte que o bloco não tem
 * como saber, e por isso a única que o operador precisa escrever.
 */

/** Termos que o bloco injetado passou a possuir. */
const DO_BLOCO = [
  { termo: "desconto", regra: "5 (condição não sai de você)" },
  { termo: "português", regra: "1 (idioma)" },
  { termo: "invent", regra: "2 (não invente)" },
  { termo: "sem confirmar", regra: "2 (prazo só vem de ferramenta)" },
  { termo: "o que sabe com certeza", regra: "2 (não invente)" },
  { termo: "parágrafos", regra: "cauda de conversa (tamanho)" },
  { termo: "emoji", regra: "cauda de conversa (formato)" },
  { termo: "markdown", regra: "cauda de conversa (formato)" },
];

describe("o prompt-semente não repete o bloco injetado", () => {
  it("não usa nenhum termo que as Regras da Casa já possuem", () => {
    const texto = PROMPT_BASE.toLowerCase();

    for (const { termo, regra } of DO_BLOCO) {
      expect(texto, `"${termo}" já é garantido pela regra ${regra}`).not.toContain(
        termo,
      );
    }
  });

  it("nenhuma frase inteira aparece nos dois textos", () => {
    // Repetir uma regra não quebra o agente — só é cobrada duas vezes e
    // convida o operador a editar a cópia achando que edita o original.
    const injetado = `${NUCLEO}\n${caudaDeConversa(true)}`.toLowerCase();

    const frases = PROMPT_BASE.split(/[.\n]/)
      .map((f) => f.trim().toLowerCase())
      .filter((f) => f.length > 25);

    for (const frase of frases) {
      expect(injetado, `esta frase já está no bloco: "${frase}"`).not.toContain(
        frase,
      );
    }
  });

  it("nomeia assunto e tom, que é o que só o operador sabe", () => {
    // O bloco injetado não tem como saber o que é com ESTE agente. Se o
    // exemplo deixar de mostrar isso, ele para de ensinar o que preencher.
    expect(PROMPT_BASE).toContain("O QUE É COM VOCÊ");
    expect(PROMPT_BASE).toContain("O QUE NÃO É COM VOCÊ");
    expect(PROMPT_BASE).toContain("COMO VOCÊ SE APRESENTA");
  });

  it("não manda o agente dizer o próprio nome", () => {
    // O nome real só chega pelo roster, que é string vazia quando não há
    // colegas com descrição de roteamento — ou seja, no primeiro agente.
    // Ordem que o prompt não tem como cumprir vira nome inventado, e diferente
    // a cada conversa: exatamente o que a regra 2 proíbe.
    expect(PROMPT_BASE.toLowerCase()).not.toContain("seu nome");
    expect(PROMPT_BASE.toLowerCase()).not.toContain("diga que você é a");
  });
});
