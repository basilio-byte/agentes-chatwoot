import { describe, expect, it } from "vitest";
import { PrazoStatus } from "@/generated/prisma/enums";
import { MOTIVO } from "./decisao";
import {
  acaoDaLinha,
  baseDaTaxa,
  contarPrazosPerdidos,
  desfechoDaLinha,
  type LinhaDePrazo,
} from "./contagem";

const linha = (over: Partial<LinhaDePrazo> = {}): LinhaDePrazo => ({
  donoId: 7,
  donoNome: "Atendente Um",
  agentId: "agente-vendas",
  status: PrazoStatus.EXECUTADO,
  acao: { tipo: "reatribuir", atendente: "Atendente Dois" },
  resultado: "reatribuída a Atendente Dois",
  chatwootConversationId: 1000,
  criadoEm: new Date("2026-09-16T13:22:00Z"),
  finalizadoEm: new Date("2026-09-16T13:33:00Z"),
  ...over,
});

/** Atalho: uma linha que terminou com a equipe respondendo a tempo. */
const respondeu = (over: Partial<LinhaDePrazo> = {}) =>
  linha({ status: PrazoStatus.CANCELADO, resultado: MOTIVO.equipeEscreveu, ...over });

describe("desfechoDaLinha", () => {
  it("separa os dois lados da mesma conferência ao vivo", () => {
    expect(desfechoDaLinha({ status: PrazoStatus.EXECUTADO, resultado: null })).toBe("perdeu");
    expect(
      desfechoDaLinha({ status: PrazoStatus.CANCELADO, resultado: MOTIVO.equipeEscreveu }),
    ).toBe("respondeu");
  });

  it("os cancelamentos que não dizem se a pessoa respondeu ficam em caixas próprias", () => {
    const cancelado = (resultado: string) =>
      desfechoDaLinha({ status: PrazoStatus.CANCELADO, resultado });

    expect(cancelado(MOTIVO.resolvida)).toBe("resolvida");
    expect(cancelado(MOTIVO.semDono)).toBe("saiu");
    expect(cancelado(MOTIVO.naoEhMaisPessoa)).toBe("saiu");
    expect(cancelado(MOTIVO.outraPessoaAssumiu)).toBe("saiu");
    expect(cancelado(MOTIVO.substituido)).toBe("substituido");
  });

  it("descartado, falhou e motivo desconhecido caem em sem_conclusao, nunca em perdeu", () => {
    expect(desfechoDaLinha({ status: PrazoStatus.DESCARTADO, resultado: "tarde demais" })).toBe(
      "sem_conclusao",
    );
    expect(desfechoDaLinha({ status: PrazoStatus.FALHOU, resultado: "Chatwoot fora do ar" })).toBe(
      "sem_conclusao",
    );
    // Uma frase reescrita em decisao.ts some da taxa em vez de virar falta.
    expect(
      desfechoDaLinha({ status: PrazoStatus.CANCELADO, resultado: "redação nova qualquer" }),
    ).toBe("sem_conclusao");
    expect(desfechoDaLinha({ status: PrazoStatus.CANCELADO, resultado: null })).toBe(
      "sem_conclusao",
    );
  });
});

describe("acaoDaLinha", () => {
  it("lê as duas ações do prazo da equipe e não chuta uma terceira", () => {
    expect(acaoDaLinha({ tipo: "reatribuir", atendente: "X" })).toBe("reatribuida");
    expect(acaoDaLinha({ tipo: "voltar_para_o_agente" })).toBe("devolvida");
    expect(acaoDaLinha({ tipo: "coisa_nova" })).toBeNull();
    expect(acaoDaLinha(null)).toBeNull();
  });
});

describe("contarPrazosPerdidos — a taxa", () => {
  it("a taxa é perdeu sobre perdeu mais respondeu", () => {
    const { pessoas, totais } = contarPrazosPerdidos([
      linha({ chatwootConversationId: 1 }),
      respondeu({ chatwootConversationId: 2 }),
      respondeu({ chatwootConversationId: 3 }),
      respondeu({ chatwootConversationId: 4 }),
    ]);

    expect(pessoas[0].perdeu).toBe(1);
    expect(pessoas[0].respondeu).toBe(3);
    expect(pessoas[0].taxa).toBeCloseTo(0.25);
    expect(totais.taxa).toBeCloseTo(0.25);
  });

  it("quem atende mais não fica pior que quem atende pouco", () => {
    const muitas = [
      ...Array.from({ length: 27 }, (_, i) => respondeu({ chatwootConversationId: 100 + i })),
      ...Array.from({ length: 3 }, (_, i) => linha({ chatwootConversationId: 200 + i })),
    ];
    const poucas = [
      respondeu({ donoId: 9, donoNome: "Atendente Dois", chatwootConversationId: 300 }),
      respondeu({ donoId: 9, donoNome: "Atendente Dois", chatwootConversationId: 301 }),
      linha({ donoId: 9, donoNome: "Atendente Dois", chatwootConversationId: 302 }),
      linha({ donoId: 9, donoNome: "Atendente Dois", chatwootConversationId: 303 }),
    ];

    const { pessoas } = contarPrazosPerdidos([...muitas, ...poucas]);
    const um = pessoas.find((p) => p.nome === "Atendente Um")!;
    const dois = pessoas.find((p) => p.nome === "Atendente Dois")!;

    // Em números absolutos o Um parece o pior (3 contra 2); na taxa, não.
    expect(um.perdeu).toBeGreaterThan(dois.perdeu);
    expect(um.taxa).toBeCloseTo(0.1);
    expect(dois.taxa).toBeCloseTo(0.5);
    expect(um.recebeu).toBe(30);
    expect(dois.recebeu).toBe(4);
  });

  it("sem perdeu nem respondeu, a taxa é nula em vez de zero", () => {
    const { pessoas } = contarPrazosPerdidos([
      linha({ status: PrazoStatus.CANCELADO, resultado: MOTIVO.resolvida }),
      linha({ status: PrazoStatus.DESCARTADO, resultado: "tarde demais" }),
    ]);

    expect(pessoas[0].recebeu).toBe(2);
    expect(pessoas[0].taxa).toBeNull();
    expect(baseDaTaxa(pessoas[0])).toBe(0);
  });

  it("⚠ prazo substituído não conta nem como entrega", () => {
    // Uma entrega só, com o prazo zerado três vezes antes de vencer.
    const { pessoas, totais } = contarPrazosPerdidos([
      linha({ status: PrazoStatus.CANCELADO, resultado: MOTIVO.substituido }),
      linha({ status: PrazoStatus.CANCELADO, resultado: MOTIVO.substituido }),
      linha({ status: PrazoStatus.CANCELADO, resultado: MOTIVO.substituido }),
      linha(),
    ]);

    expect(totais.recebeu).toBe(1);
    expect(pessoas[0].recebeu).toBe(1);
    expect(pessoas[0].taxa).toBe(1);
  });
});

describe("contarPrazosPerdidos — os desfechos e o resto", () => {
  it("soma por pessoa e separa as duas ações da perda", () => {
    const { pessoas } = contarPrazosPerdidos([
      linha({ chatwootConversationId: 1 }),
      linha({ chatwootConversationId: 2 }),
      linha({ chatwootConversationId: 3, acao: { tipo: "voltar_para_o_agente" } }),
      linha({ donoId: 9, donoNome: "Atendente Dois", chatwootConversationId: 4 }),
    ]);

    expect(pessoas.map((p) => [p.nome, p.perdeu, p.reatribuidas, p.devolvidas])).toEqual([
      ["Atendente Um", 3, 2, 1],
      ["Atendente Dois", 1, 1, 0],
    ]);
  });

  it("a mesma pessoa sem nome numa das linhas não vira duas pessoas", () => {
    const { pessoas } = contarPrazosPerdidos([
      linha({ donoNome: null, chatwootConversationId: 1 }),
      linha({ chatwootConversationId: 2 }),
    ]);

    expect(pessoas).toHaveLength(1);
    expect(pessoas[0].nome).toBe("Atendente Um");
    expect(pessoas[0].perdeu).toBe(2);
  });

  it("sem nome em lugar nenhum, identifica pelo id em vez de sumir", () => {
    const { pessoas } = contarPrazosPerdidos([linha({ donoNome: null })]);
    expect(pessoas[0].nome).toBe("Atendente #7");
  });

  it("agrupa por agente, que é o fluxo onde a perda acontece", () => {
    const { porAgente } = contarPrazosPerdidos([
      linha({ chatwootConversationId: 1 }),
      linha({ chatwootConversationId: 2 }),
      respondeu({ chatwootConversationId: 3 }),
      linha({ agentId: "agente-salas", chatwootConversationId: 4 }),
    ]);

    expect(porAgente.map((a) => [a.agentId, a.perdeu, a.recebeu])).toEqual([
      ["agente-vendas", 2, 3],
      ["agente-salas", 1, 1],
    ]);
    expect(porAgente[0].taxa).toBeCloseTo(2 / 3);
  });

  it("conta quem assumiu depois, e as voltas ao agente à parte", () => {
    const { destinos, devolvidasAoAgente } = contarPrazosPerdidos([
      linha({ chatwootConversationId: 1 }),
      linha({ chatwootConversationId: 2 }),
      linha({ chatwootConversationId: 3, acao: { tipo: "reatribuir", atendente: "Atendente Três" } }),
      linha({ chatwootConversationId: 4, acao: { tipo: "voltar_para_o_agente" } }),
    ]);

    expect(destinos).toEqual([
      { nome: "Atendente Dois", vezes: 2 },
      { nome: "Atendente Três", vezes: 1 },
    ]);
    expect(devolvidasAoAgente).toBe(1);
  });

  it("conta conversas afetadas e as que perderam prazo mais de uma vez", () => {
    const { conversas } = contarPrazosPerdidos([
      linha({ chatwootConversationId: 1 }),
      linha({ chatwootConversationId: 1 }),
      linha({ chatwootConversationId: 2 }),
      // Respondida não é conversa afetada.
      respondeu({ chatwootConversationId: 3 }),
    ]);

    expect(conversas).toEqual({ afetadas: 2, maisDeUmaVez: 1 });
  });

  it("só o que não teve conclusão vai para o bloco Fora da conta", () => {
    const { foraDaConta } = contarPrazosPerdidos([
      linha({ chatwootConversationId: 1 }),
      respondeu({ chatwootConversationId: 2 }),
      linha({
        chatwootConversationId: 3,
        status: PrazoStatus.DESCARTADO,
        resultado: "tarde demais",
        finalizadoEm: new Date("2026-09-16T10:00:00Z"),
      }),
      linha({
        chatwootConversationId: 4,
        status: PrazoStatus.FALHOU,
        resultado: "Chatwoot fora do ar",
        finalizadoEm: new Date("2026-09-16T11:00:00Z"),
      }),
    ]);

    // Mais recente primeiro: é a ordem em que alguém confere à mão.
    expect(foraDaConta.map((f) => [f.conversa, f.status])).toEqual([
      [4, PrazoStatus.FALHOU],
      [3, PrazoStatus.DESCARTADO],
    ]);
    expect(foraDaConta[0].quem).toBe("Atendente Um");
  });

  it("a última perda é a mais recente, com destino e conversa", () => {
    const { pessoas } = contarPrazosPerdidos([
      linha({ chatwootConversationId: 1, finalizadoEm: new Date("2026-09-10T10:00:00Z") }),
      linha({
        chatwootConversationId: 2,
        finalizadoEm: new Date("2026-09-15T10:00:00Z"),
        acao: { tipo: "reatribuir", atendente: "Atendente Três" },
      }),
      // Mais nova, mas não é perda: não pode virar "última vez que perdeu".
      respondeu({ chatwootConversationId: 3, finalizadoEm: new Date("2026-09-16T10:00:00Z") }),
    ]);

    expect(pessoas[0].ultimaPerda).toMatchObject({
      conversa: 2,
      acao: "reatribuida",
      destino: "Atendente Três",
    });
  });

  it("sem finalizadoEm, a ocorrência vale pelo instante em que o prazo nasceu", () => {
    const { pessoas } = contarPrazosPerdidos([
      linha({ finalizadoEm: null, criadoEm: new Date("2026-09-14T10:00:00Z") }),
    ]);
    expect(pessoas[0].ultimaPerda?.quando).toEqual(new Date("2026-09-14T10:00:00Z"));
  });

  it("lista toda perda, não só a última, com o nome da mesma linha da tabela", () => {
    const { perdas } = contarPrazosPerdidos([
      linha({ chatwootConversationId: 1, finalizadoEm: new Date("2026-09-10T10:00:00Z") }),
      // Sem nome nesta linha: tem de sair com o nome que a pessoa tem na tabela.
      linha({
        chatwootConversationId: 2,
        donoNome: null,
        agentId: "agente-salas",
        finalizadoEm: new Date("2026-09-15T10:00:00Z"),
        acao: { tipo: "voltar_para_o_agente" },
      }),
      linha({
        chatwootConversationId: 3,
        donoId: 9,
        donoNome: "Atendente Três",
        finalizadoEm: new Date("2026-09-12T10:00:00Z"),
      }),
      // Não é perda: não entra na lista.
      respondeu({ chatwootConversationId: 4, finalizadoEm: new Date("2026-09-16T10:00:00Z") }),
      linha({
        chatwootConversationId: 5,
        status: PrazoStatus.FALHOU,
        resultado: "Chatwoot fora do ar",
      }),
    ]);

    // Mais recente primeiro, e de qualquer pessoa.
    expect(perdas.map((p) => [p.conversa, p.quem, p.agentId, p.acao, p.destino])).toEqual([
      [2, "Atendente Um", "agente-salas", "devolvida", null],
      [3, "Atendente Três", "agente-vendas", "reatribuida", "Atendente Dois"],
      [1, "Atendente Um", "agente-vendas", "reatribuida", "Atendente Dois"],
    ]);
  });

  it("cada pessoa carrega só as próprias perdas, da mais recente para a mais antiga", () => {
    const { pessoas } = contarPrazosPerdidos([
      linha({ chatwootConversationId: 1, finalizadoEm: new Date("2026-09-10T10:00:00Z") }),
      linha({
        chatwootConversationId: 2,
        finalizadoEm: new Date("2026-09-15T10:00:00Z"),
        acao: { tipo: "voltar_para_o_agente" },
      }),
      linha({
        chatwootConversationId: 3,
        donoId: 9,
        donoNome: "Atendente Três",
        finalizadoEm: new Date("2026-09-12T10:00:00Z"),
      }),
      // Respondida é da pessoa, mas não é perda.
      respondeu({ chatwootConversationId: 4, finalizadoEm: new Date("2026-09-16T10:00:00Z") }),
    ]);

    const perdasDe = (nome: string) =>
      pessoas.find((p) => p.nome === nome)?.perdas.map((p) => [p.conversa, p.acao]);

    expect(perdasDe("Atendente Um")).toEqual([
      [2, "devolvida"],
      [1, "reatribuida"],
    ]);
    expect(perdasDe("Atendente Três")).toEqual([[3, "reatribuida"]]);
    // A última perda da tabela é a primeira da lista, sempre.
    expect(pessoas.find((p) => p.nome === "Atendente Um")?.ultimaPerda?.conversa).toBe(2);
  });

  it("quem só respondeu tem lista de perdas vazia", () => {
    const { pessoas } = contarPrazosPerdidos([respondeu()]);
    expect(pessoas[0].perdas).toEqual([]);
    expect(pessoas[0].ultimaPerda).toBeNull();
  });

  it("lista vazia não quebra", () => {
    const vazio = contarPrazosPerdidos([]);
    expect(vazio.pessoas).toEqual([]);
    expect(vazio.perdas).toEqual([]);
    expect(vazio.totais.recebeu).toBe(0);
    expect(vazio.totais.taxa).toBeNull();
    expect(vazio.conversas).toEqual({ afetadas: 0, maisDeUmaVez: 0 });
  });
});
