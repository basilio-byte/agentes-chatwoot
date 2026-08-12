import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { RunSource } from "@/generated/prisma/enums";
import { SEM_MODELO, type LinhaDeConsumo } from "./agregacao";
import type { Intervalo } from "./periodo";

/**
 * Teto de linhas por apuração.
 *
 * A agregação é feita em memória (ver `agregacao.ts`), então precisa de um
 * limite explícito. Vinte mil execuções são muito mais do que esta operação
 * produz num mês; passar disso é sinal de que o período pedido é grande demais,
 * e a tela diz isso em vez de devolver um número pela metade — relatório
 * truncado em silêncio é o pior desfecho numa apuração financeira.
 */
export const TETO_DE_LINHAS = 20_000;

export type FiltroDeConsumo = {
  intervalo: Intervalo;
  agentId?: string | null;
  /** `SEM_MODELO` filtra as execuções anteriores ao registro do modelo. */
  model?: string | null;
  source?: RunSource | null;
};

export function montarWhere(filtro: FiltroDeConsumo): Prisma.AgentRunWhereInput {
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
    ...(filtro.model
      ? { model: filtro.model === SEM_MODELO ? null : filtro.model }
      : {}),
    ...(filtro.source ? { source: filtro.source } : {}),
  };
}

export type ResultadoDaVarredura =
  | { excedeu: false; linhas: LinhaDeConsumo[] }
  | { excedeu: true; total: number };

export async function varrerPeriodo(
  filtro: FiltroDeConsumo,
): Promise<ResultadoDaVarredura> {
  const where = montarWhere(filtro);
  const total = await db.agentRun.count({ where });
  if (total > TETO_DE_LINHAS) return { excedeu: true, total };

  const linhas = await db.agentRun.findMany({
    where,
    orderBy: { createdAt: "asc" },
    select: {
      createdAt: true,
      model: true,
      agentId: true,
      source: true,
      status: true,
      costUsd: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      latencyMs: true,
      conversationId: true,
    },
  });

  return {
    excedeu: false,
    // Decimal não atravessa a fronteira de serialização do React, e a
    // agregação é aritmética simples de ponto flutuante — converte aqui, uma
    // vez, em vez de espalhar `Number(...)` pela tela inteira.
    linhas: linhas.map((l) => ({ ...l, costUsd: Number(l.costUsd ?? 0) })),
  };
}

export type OpcoesDeFiltro = {
  agentes: { id: string; nome: string; arquivado: boolean }[];
  modelos: string[];
  /** Já houve execução sem modelo registrado em algum momento. */
  temSemModelo: boolean;
};

/**
 * Opções dos seletores. Vêm de TODO o histórico, não do período aberto: um
 * filtro que some da lista ao trocar o período deixa o usuário preso num
 * recorte que ele não consegue mais reproduzir.
 *
 * Agente arquivado entra na lista — ele tem histórico de custo, e arquivar não
 * apaga a fatura.
 */
export async function opcoesDeFiltro(): Promise<OpcoesDeFiltro> {
  const [agentes, modelos] = await Promise.all([
    db.agent.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, archivedAt: true },
    }),
    db.agentRun.groupBy({ by: ["model"], _count: { _all: true } }),
  ]);

  return {
    agentes: agentes.map((a) => ({
      id: a.id,
      nome: a.name,
      arquivado: Boolean(a.archivedAt),
    })),
    modelos: modelos
      .map((m) => m.model)
      .filter((m): m is string => Boolean(m))
      .sort((a, b) => a.localeCompare(b)),
    temSemModelo: modelos.some((m) => m.model === null),
  };
}

export const ROTULO_DA_FONTE: Record<RunSource, string> = {
  [RunSource.CHATWOOT]: "Chatwoot",
  [RunSource.TRIGGER]: "Gatilho HTTP",
  [RunSource.PLAYGROUND]: "Playground",
};

export function normalizarFonte(valor: string | undefined | null) {
  return valor && valor in ROTULO_DA_FONTE ? (valor as RunSource) : null;
}
