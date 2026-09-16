import { describe, expect, it } from "vitest";
import { PrazoStatus } from "@/generated/prisma/enums";
import {
  contarPrazosPerdidos,
  desfechoDaAcao,
  type LinhaDePrazo,
} from "./contagem";

const linha = (over: Partial<LinhaDePrazo> = {}): LinhaDePrazo => ({
  donoId: 7,
  donoNome: "Atendente A",
  status: PrazoStatus.EXECUTADO,
  acao: { tipo: "reatribuir", atendente: "Atendente B" },
  resultado: "reatribuída a Atendente B",
  minutos: 10,
  chatwootConversationId: 1000,
  criadoEm: new Date("2026-09-16T13:22:00Z"),
  finalizadoEm: new Date("2026-09-16T13:33:00Z"),
  ...over,
});

describe("desfechoDaAcao", () => {
  it("lê as duas ações do prazo da equipe", () => {
    expect(desfechoDaAcao({ tipo: "reatribuir", atendente: "X" })).toBe("reatribuida");
    expect(desfechoDaAcao({ tipo: "voltar_para_o_agente" })).toBe("devolvida");
  });

  it("não chuta desfecho para ação que não conhece", () => {
    expect(desfechoDaAcao({ tipo: "coisa_nova" })).toBeNull();
    expect(desfechoDaAcao(null)).toBeNull();
    expect(desfechoDaAcao("reatribuir")).toBeNull();
  });
});

describe("contarPrazosPerdidos", () => {
  it("soma por pessoa e separa os dois desfechos", () => {
    const { pessoas, total } = contarPrazosPerdidos([
      linha(),
      linha({ chatwootConversationId: 1001 }),
      linha({ chatwootConversationId: 1002, acao: { tipo: "voltar_para_o_agente" } }),
      linha({ donoId: 9, donoNome: "Atendente C", chatwootConversationId: 1003 }),
    ]);

    expect(total).toBe(4);
    expect(pessoas.map((p) => [p.nome, p.total, p.reatribuidas, p.devolvidas])).toEqual([
      ["Atendente A", 3, 2, 1],
      ["Atendente C", 1, 1, 0],
    ]);
  });

  it("a mesma pessoa sem nome numa das linhas não vira duas pessoas", () => {
    const { pessoas } = contarPrazosPerdidos([
      linha({ donoNome: null }),
      linha({ chatwootConversationId: 1001 }),
    ]);

    expect(pessoas).toHaveLength(1);
    expect(pessoas[0].nome).toBe("Atendente A");
    expect(pessoas[0].total).toBe(2);
  });

  it("sem nome em lugar nenhum, identifica pelo id em vez de sumir", () => {
    const { pessoas } = contarPrazosPerdidos([linha({ donoNome: null })]);
    expect(pessoas[0].nome).toBe("Atendente #7");
  });

  it("ação desconhecida ainda conta como falta, mas não inventa coluna", () => {
    const { pessoas, total } = contarPrazosPerdidos([linha({ acao: { tipo: "?" } })]);
    expect(total).toBe(1);
    expect([pessoas[0].reatribuidas, pessoas[0].devolvidas]).toEqual([0, 0]);
  });

  it("só EXECUTADO é falta; cancelado, descartado e falhou ficam fora da conta", () => {
    const { pessoas, total, foraDaConta } = contarPrazosPerdidos([
      linha(),
      linha({
        chatwootConversationId: 1001,
        status: PrazoStatus.CANCELADO,
        resultado: "a equipe respondeu",
        finalizadoEm: new Date("2026-09-16T09:00:00Z"),
      }),
      linha({
        chatwootConversationId: 1002,
        status: PrazoStatus.DESCARTADO,
        resultado: "tarde demais",
        finalizadoEm: new Date("2026-09-16T10:00:00Z"),
      }),
      linha({
        chatwootConversationId: 1003,
        status: PrazoStatus.FALHOU,
        resultado: "Chatwoot fora do ar",
        finalizadoEm: new Date("2026-09-16T11:00:00Z"),
      }),
    ]);

    expect(total).toBe(1);
    expect(pessoas[0].total).toBe(1);
    // Mais recente primeiro: é a ordem em que alguém confere à mão.
    expect(foraDaConta.map((f) => [f.conversa, f.status])).toEqual([
      [1003, PrazoStatus.FALHOU],
      [1002, PrazoStatus.DESCARTADO],
      [1001, PrazoStatus.CANCELADO],
    ]);
    // Quem estava com a conversa aparece no bloco, mas não na conta de ninguém.
    expect(foraDaConta[0].quem).toBe("Atendente A");
  });

  it("a última ocorrência é a mais recente, com a conversa", () => {
    const { pessoas } = contarPrazosPerdidos([
      linha({ chatwootConversationId: 1001, finalizadoEm: new Date("2026-09-10T10:00:00Z") }),
      linha({
        chatwootConversationId: 1002,
        finalizadoEm: new Date("2026-09-15T10:00:00Z"),
        acao: { tipo: "voltar_para_o_agente" },
      }),
      linha({ chatwootConversationId: 1003, finalizadoEm: new Date("2026-09-12T10:00:00Z") }),
    ]);

    expect(pessoas[0].ultima).toMatchObject({ conversa: 1002, desfecho: "devolvida" });
  });

  it("sem finalizadoEm, a ocorrência vale pelo instante em que o prazo nasceu", () => {
    const { pessoas } = contarPrazosPerdidos([
      linha({ finalizadoEm: null, criadoEm: new Date("2026-09-14T10:00:00Z") }),
    ]);
    expect(pessoas[0].ultima?.quando).toEqual(new Date("2026-09-14T10:00:00Z"));
  });

  it("lista vazia não quebra", () => {
    expect(contarPrazosPerdidos([])).toEqual({ pessoas: [], total: 0, foraDaConta: [] });
  });
});
