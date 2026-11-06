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

describe("resolverAtendente com ausência", () => {
  const EQUIPE_COM_FELIPE: Atendente[] = [
    ...EQUIPE,
    { id: 7, name: "Felipe Fragoso", email: "felipe@seahub.com.br" },
  ];
  const FERIAS = { nome: "Laercio", substituto: "Felipe", ate: "2026-11-19" };
  const em = (hoje: string, ausencias = [FERIAS]) => ({ ausencias, hoje });

  it("quem está ausente é trocado pelo substituto, e o resultado diz quem foi trocado", () => {
    const r = resolverAtendente("Laércio", EQUIPE_COM_FELIPE, em("2026-11-06"));
    expect(r).toMatchObject({
      tipo: "achado",
      atendente: { id: 7 },
      substituiuA: "Laércio Dias",
    });
  });

  it("vale para o que o prompt escreve: primeiro nome, nome inteiro, e-mail e id", () => {
    for (const termo of ["Laercio", "Laércio Dias", "laercio@seahub.com.br", "5"]) {
      expect(resolverAtendente(termo, EQUIPE_COM_FELIPE, em("2026-11-06"))).toMatchObject({
        atendente: { id: 7 },
      });
    }
  });

  it("⚠ vale no último dia e some no seguinte, sozinha", () => {
    expect(resolverAtendente("Laercio", EQUIPE_COM_FELIPE, em("2026-11-19"))).toMatchObject({
      atendente: { id: 7 },
    });
    const depois = resolverAtendente("Laercio", EQUIPE_COM_FELIPE, em("2026-11-20"));
    expect(depois).toMatchObject({ atendente: { id: 5 } });
    expect(depois.tipo === "achado" && depois.substituiuA).toBeUndefined();
  });

  it("não mexe em ninguém além do ausente", () => {
    const r = resolverAtendente("Alan", EQUIPE_COM_FELIPE, em("2026-11-06"));
    expect(r).toMatchObject({ atendente: { id: 1 } });
    expect(r.tipo === "achado" && r.substituiuA).toBeUndefined();
  });

  it("sem opções, o comportamento é o de sempre", () => {
    expect(resolverAtendente("Laercio", EQUIPE_COM_FELIPE)).toMatchObject({
      atendente: { id: 5 },
    });
  });

  it("⚠ substituto que não existe mantém quem foi pedido: conversa nunca fica sem dono", () => {
    const r = resolverAtendente("Laercio", EQUIPE, em("2026-11-06"));
    expect(r).toMatchObject({ tipo: "achado", atendente: { id: 5 } });
    expect(r.tipo === "achado" && r.substituiuA).toBeUndefined();
  });

  it("⚠ substituto ambíguo mantém quem foi pedido, em vez de chutar um dos dois", () => {
    const comDois = [
      ...EQUIPE,
      { id: 7, name: "Felipe Fragoso" },
      { id: 8, name: "Felipe Santos" },
    ];
    expect(resolverAtendente("Laercio", comDois, em("2026-11-06"))).toMatchObject({
      atendente: { id: 5 },
    });
  });

  it("uma troca só: o substituto também ausente não encadeia", () => {
    const ausencias = [
      FERIAS,
      { nome: "Felipe", substituto: "Alan", ate: "2026-11-30" },
    ];
    expect(resolverAtendente("Laercio", EQUIPE_COM_FELIPE, em("2026-11-06", ausencias))).toMatchObject({
      atendente: { id: 7 },
    });
  });

  it("ausente que não existe na equipe não atrapalha ninguém", () => {
    const r = resolverAtendente("Alan", EQUIPE, em("2026-11-06", [
      { nome: "Fantasma", substituto: "Kelly", ate: "2026-11-30" },
    ]));
    expect(r).toMatchObject({ atendente: { id: 1 } });
  });

  it("quem não existe continua devolvendo a lista", () => {
    expect(resolverAtendente("Fernanda", EQUIPE_COM_FELIPE, em("2026-11-06")).tipo).toBe("nenhum");
  });
});
