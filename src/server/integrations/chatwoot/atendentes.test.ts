import { describe, expect, it } from "vitest";
import { resolverAtendente, type Atendente } from "./atendentes";

const EQUIPE: Atendente[] = [
  { id: 1, name: "Alan Ribeiro", email: "alan@seahub.com.br" },
  { id: 2, name: "Kelly Souza", email: "kelly@seahub.com.br" },
  { id: 3, name: "Arthur Menezes", email: "arthur@seahub.com.br" },
  { id: 4, name: "Ítalo Prado", email: "italo@seahub.com.br" },
  { id: 5, name: "Laércio Dias", email: "laercio@seahub.com.br" },
];

describe("resolverAtendente", () => {
  it("casa pelo primeiro nome, que é como o prompt escreve", () => {
    expect(resolverAtendente("Arthur", EQUIPE)).toMatchObject({
      tipo: "achado",
      atendente: { id: 3 },
    });
  });

  it("ignora acento — o prompt escreve 'Italo', o cadastro diz 'Ítalo'", () => {
    expect(resolverAtendente("Italo", EQUIPE)).toMatchObject({
      tipo: "achado",
      atendente: { id: 4 },
    });
  });

  it("casa pelo nome inteiro e pelo e-mail", () => {
    expect(resolverAtendente("Kelly Souza", EQUIPE)).toMatchObject({
      tipo: "achado",
      atendente: { id: 2 },
    });
    expect(resolverAtendente("laercio@seahub.com.br", EQUIPE)).toMatchObject({
      tipo: "achado",
      atendente: { id: 5 },
    });
  });

  it("casa pelo id, quando o agente já o tem em mãos", () => {
    expect(resolverAtendente("3", EQUIPE)).toMatchObject({
      tipo: "achado",
      atendente: { id: 3 },
    });
  });

  it("dois com o mesmo primeiro nome viram ambiguidade, não chute", () => {
    const comXara = [...EQUIPE, { id: 6, name: "Arthur Lima" }];
    const r = resolverAtendente("Arthur", comXara);

    expect(r.tipo).toBe("ambiguo");
    expect(r.tipo === "ambiguo" && r.candidatos).toEqual([
      "Arthur Menezes",
      "Arthur Lima",
    ]);
  });

  it("nome inteiro desempata o que o primeiro nome não resolve", () => {
    const comXara = [...EQUIPE, { id: 6, name: "Arthur Lima" }];
    expect(resolverAtendente("Arthur Lima", comXara)).toMatchObject({
      tipo: "achado",
      atendente: { id: 6 },
    });
  });

  it("quem não existe devolve a lista, para o modelo se corrigir", () => {
    const r = resolverAtendente("Fernanda", EQUIPE);

    expect(r.tipo).toBe("nenhum");
    expect(r.tipo === "nenhum" && r.disponiveis).toContain("Alan Ribeiro");
  });

  it("termo vazio não casa com ninguém", () => {
    expect(resolverAtendente("   ", EQUIPE).tipo).toBe("nenhum");
  });
});
