import { describe, expect, it, vi } from "vitest";
import { TipoDeLacuna } from "@/generated/prisma/enums";
import type { Intervalo } from "@/server/consumo/periodo";

const agoraDoTeste = new Date("2026-10-27T15:00:00Z");

const db = {
  lacunaDoAgente: {
    findMany: vi.fn(async () => [
      {
        id: "l1",
        createdAt: agoraDoTeste,
        tipo: TipoDeLacuna.FALTA_FERRAMENTA,
        oQueFaltou: "consultar a situação de um contrato",
        motivo: "cliente quer saber do contrato",
        chatwootConversationId: 55,
        runId: "run-1",
        agent: { id: "a1", key: "contratos", name: "Contratos" },
      },
    ]),
    count: vi.fn(async () => 7),
    groupBy: vi.fn(async (args: { by: string[] }) =>
      args.by[0] === "tipo"
        ? [
            { tipo: TipoDeLacuna.FALTA_FERRAMENTA, _count: { _all: 4 } },
            { tipo: TipoDeLacuna.NAO_ENTENDI, _count: { _all: 3 } },
          ]
        : [
            { agentId: "a1", _count: { _all: 5 } },
            { agentId: "sumiu", _count: { _all: 2 } },
          ],
    ),
  },
  agent: {
    findMany: vi.fn(async () => [{ id: "a1", key: "contratos", name: "Contratos" }]),
  },
};
vi.mock("@/lib/db", () => ({ db }));

const { agentesParaFiltro, lerLacunas, montarWhere, normalizarTipo } = await import(
  "./consulta"
);

const semPeriodo: Intervalo = {
  inicio: null,
  fim: null,
  primeiroDia: null,
  ultimoDia: null,
  rotulo: "Tudo",
};

describe("normalizarTipo", () => {
  it("aceita o que o banco conhece e descarta o resto", () => {
    expect(normalizarTipo("NAO_ENTENDI")).toBe(TipoDeLacuna.NAO_ENTENDI);
    expect(normalizarTipo("qualquer")).toBeNull();
    expect(normalizarTipo("")).toBeNull();
    expect(normalizarTipo(undefined)).toBeNull();
  });
});

describe("montarWhere", () => {
  it("sem filtro nenhum, não restringe nada", () => {
    expect(montarWhere({ intervalo: semPeriodo })).toEqual({});
  });

  it("o fim do período é EXCLUSIVO", () => {
    const inicio = new Date("2026-10-26T03:00:00Z");
    const fim = new Date("2026-10-27T03:00:00Z");

    expect(montarWhere({ intervalo: { ...semPeriodo, inicio, fim } })).toEqual({
      createdAt: { gte: inicio, lt: fim },
    });
  });

  it("agente e tipo entram quando informados", () => {
    expect(
      montarWhere({
        intervalo: semPeriodo,
        agentId: "a1",
        tipo: TipoDeLacuna.NAO_ENTENDI,
      }),
    ).toEqual({ agentId: "a1", tipo: TipoDeLacuna.NAO_ENTENDI });
  });

  it("os totais por tipo ignoram o filtro de tipo, para dar para trocá-lo", () => {
    const filtro = {
      intervalo: semPeriodo,
      agentId: "a1",
      tipo: TipoDeLacuna.NAO_ENTENDI,
    };

    expect(montarWhere(filtro, { incluirTipo: false })).toEqual({ agentId: "a1" });
  });
});

describe("lerLacunas", () => {
  it("devolve os totais inteiros, com o tipo sem ocorrência zerado", async () => {
    const resumo = await lerLacunas({ intervalo: semPeriodo }, 30);

    expect(resumo.total).toBe(7);
    expect(resumo.porTipo).toEqual({
      [TipoDeLacuna.FALTA_INSTRUCAO]: 0,
      [TipoDeLacuna.FALTA_FERRAMENTA]: 4,
      [TipoDeLacuna.NAO_ENTENDI]: 3,
    });
  });

  it("nomeia os agentes, e avisa quando o agente já foi removido", async () => {
    const resumo = await lerLacunas({ intervalo: semPeriodo }, 30);

    expect(resumo.porAgente).toEqual([
      { id: "a1", chave: "contratos", nome: "Contratos", total: 5 },
      { id: "sumiu", chave: "", nome: "agente removido", total: 2 },
    ]);
  });

  it("o limite corta só a lista, não os totais", async () => {
    await lerLacunas({ intervalo: semPeriodo }, 12);

    expect(db.lacunaDoAgente.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 12, orderBy: { createdAt: "desc" } }),
    );
    const resumo = await lerLacunas({ intervalo: semPeriodo }, 1);
    expect(resumo.itens).toHaveLength(1);
    expect(resumo.total).toBe(7);
  });

  it("traduz a linha do banco para a que a tela e o MCP leem", async () => {
    const { itens } = await lerLacunas({ intervalo: semPeriodo }, 30);

    expect(itens[0]).toEqual({
      id: "l1",
      criadaEm: agoraDoTeste,
      tipo: TipoDeLacuna.FALTA_FERRAMENTA,
      oQueFaltou: "consultar a situação de um contrato",
      motivo: "cliente quer saber do contrato",
      agente: { id: "a1", chave: "contratos", nome: "Contratos" },
      chatwootConversationId: 55,
      runId: "run-1",
    });
  });
});

describe("agentesParaFiltro", () => {
  it("marca o arquivado, que continua na lista para o recorte não sumir", async () => {
    db.agent.findMany.mockResolvedValueOnce([
      { id: "a1", name: "Contratos", archivedAt: null },
      { id: "a2", name: "Antigo", archivedAt: new Date() },
    ] as never);

    expect(await agentesParaFiltro()).toEqual([
      { id: "a1", nome: "Contratos", arquivado: false },
      { id: "a2", nome: "Antigo", arquivado: true },
    ]);
  });
});
