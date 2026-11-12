import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { SituacaoDaLacuna, TipoDeLacuna } from "@/generated/prisma/enums";
import type { Intervalo } from "@/server/consumo/periodo";

/**
 * Leitura do relatório de lacunas — a MESMA para a tela `/lacunas` e para a
 * ferramenta `listar_lacunas_dos_agentes` do MCP. Quem lê pelos dois lados vê
 * os mesmos números; duas consultas escritas à parte divergiriam na primeira
 * mudança de filtro.
 */

export type FiltroDeLacunas = {
  intervalo: Intervalo;
  agentId?: string | null;
  tipo?: TipoDeLacuna | null;
  /** Nulo = abertas e resolvidas. A tela e o MCP passam sempre uma das duas. */
  situacao?: SituacaoDaLacuna | null;
};

export type LacunaListada = {
  id: string;
  criadaEm: Date;
  tipo: TipoDeLacuna;
  situacao: SituacaoDaLacuna;
  oQueFaltou: string;
  motivo: string;
  agente: { id: string; chave: string; nome: string };
  chatwootConversationId: number;
  runId: string | null;
  /** Só nas resolvidas: quando, por quem e o que foi feito. */
  resolvidaEm: Date | null;
  resolvidaPor: string | null;
  resolucao: string | null;
};

export type ResumoDeLacunas = {
  /** O que casa com os filtros, antes do corte de `limite`. */
  total: number;
  /** Quantas lacunas de cada tipo — sem o filtro de tipo, para dar para trocá-lo. */
  porTipo: Record<TipoDeLacuna, number>;
  /**
   * Quantas abertas e quantas resolvidas — sem o filtro de situação, para o
   * contador de cada aba ser verdade mesmo com a outra aberta.
   */
  porSituacao: Record<SituacaoDaLacuna, number>;
  /** Quais agentes mais travam, dentro do filtro inteiro. */
  porAgente: { id: string; chave: string; nome: string; total: number }[];
  itens: LacunaListada[];
};

export function normalizarTipo(valor: string | null | undefined): TipoDeLacuna | null {
  return valor && valor in TipoDeLacuna ? (valor as TipoDeLacuna) : null;
}

export function normalizarSituacao(
  valor: string | null | undefined,
): SituacaoDaLacuna | null {
  return valor && valor in SituacaoDaLacuna ? (valor as SituacaoDaLacuna) : null;
}

export function montarWhere(
  filtro: FiltroDeLacunas,
  {
    incluirTipo = true,
    incluirSituacao = true,
  }: { incluirTipo?: boolean; incluirSituacao?: boolean } = {},
): Prisma.LacunaDoAgenteWhereInput {
  const { inicio, fim } = filtro.intervalo;

  return {
    ...(inicio || fim
      ? {
          createdAt: {
            ...(inicio ? { gte: inicio } : {}),
            // Exclusivo: ver o comentário em `intervaloDoPeriodo`.
            ...(fim ? { lt: fim } : {}),
          },
        }
      : {}),
    ...(filtro.agentId ? { agentId: filtro.agentId } : {}),
    ...(incluirTipo && filtro.tipo ? { tipo: filtro.tipo } : {}),
    ...(incluirSituacao && filtro.situacao ? { situacao: filtro.situacao } : {}),
  };
}

const TIPOS_ZERADOS = (): Record<TipoDeLacuna, number> => ({
  [TipoDeLacuna.FALTA_INSTRUCAO]: 0,
  [TipoDeLacuna.FALTA_FERRAMENTA]: 0,
  [TipoDeLacuna.NAO_ENTENDI]: 0,
});

const SITUACOES_ZERADAS = (): Record<SituacaoDaLacuna, number> => ({
  [SituacaoDaLacuna.ABERTA]: 0,
  [SituacaoDaLacuna.RESOLVIDA]: 0,
});

/**
 * Lacunas com os totais que a tela e o MCP mostram. As abertas, da mais recente
 * para a mais antiga (é a fila); as resolvidas, da resolvida há menos tempo para
 * a mais antiga (é o Histórico: o que acabou de ser tratado aparece primeiro).
 *
 * `limite` corta só a lista: os totais saem da contagem inteira do banco, para
 * "mostrando 50 de 312" ser verdade.
 */
export async function lerLacunas(
  filtro: FiltroDeLacunas,
  limite: number,
): Promise<ResumoDeLacunas> {
  const where = montarWhere(filtro);
  const ordem =
    filtro.situacao === SituacaoDaLacuna.RESOLVIDA
      ? ({ resolvidaEm: "desc" } as const)
      : ({ createdAt: "desc" } as const);

  const [linhas, total, porTipoBruto, porSituacaoBruto, porAgenteBruto] = await Promise.all([
    db.lacunaDoAgente.findMany({
      where,
      orderBy: ordem,
      take: limite,
      select: {
        id: true,
        createdAt: true,
        tipo: true,
        situacao: true,
        oQueFaltou: true,
        motivo: true,
        chatwootConversationId: true,
        runId: true,
        resolvidaEm: true,
        resolvidaPorNome: true,
        resolucao: true,
        agent: { select: { id: true, key: true, name: true } },
      },
    }),
    db.lacunaDoAgente.count({ where }),
    db.lacunaDoAgente.groupBy({
      by: ["tipo"],
      where: montarWhere(filtro, { incluirTipo: false }),
      _count: { _all: true },
    }),
    db.lacunaDoAgente.groupBy({
      by: ["situacao"],
      where: montarWhere(filtro, { incluirSituacao: false }),
      _count: { _all: true },
    }),
    db.lacunaDoAgente.groupBy({
      by: ["agentId"],
      where,
      _count: { _all: true },
      orderBy: { _count: { agentId: "desc" } },
      take: 10,
    }),
  ]);

  const porTipo = TIPOS_ZERADOS();
  for (const linha of porTipoBruto) porTipo[linha.tipo] = linha._count._all;

  const porSituacao = SITUACOES_ZERADAS();
  for (const linha of porSituacaoBruto) porSituacao[linha.situacao] = linha._count._all;

  const agentes = new Map(
    (
      await db.agent.findMany({
        where: { id: { in: porAgenteBruto.map((a) => a.agentId) } },
        select: { id: true, key: true, name: true },
      })
    ).map((a) => [a.id, a]),
  );

  return {
    total,
    porTipo,
    porSituacao,
    porAgente: porAgenteBruto.map((a) => ({
      id: a.agentId,
      chave: agentes.get(a.agentId)?.key ?? "",
      nome: agentes.get(a.agentId)?.name ?? "agente removido",
      total: a._count._all,
    })),
    itens: linhas.map((l) => ({
      id: l.id,
      criadaEm: l.createdAt,
      tipo: l.tipo,
      situacao: l.situacao,
      oQueFaltou: l.oQueFaltou,
      motivo: l.motivo,
      agente: { id: l.agent.id, chave: l.agent.key, nome: l.agent.name },
      chatwootConversationId: l.chatwootConversationId,
      runId: l.runId,
      resolvidaEm: l.resolvidaEm,
      resolvidaPor: l.resolvidaPorNome,
      resolucao: l.resolucao,
    })),
  };
}

/** Agentes que aparecem no seletor da tela — todos, e não só os que têm lacuna. */
export async function agentesParaFiltro() {
  const agentes = await db.agent.findMany({
    select: { id: true, name: true, archivedAt: true },
    orderBy: { name: "asc" },
  });
  return agentes.map((a) => ({
    id: a.id,
    nome: a.name,
    arquivado: a.archivedAt !== null,
  }));
}
