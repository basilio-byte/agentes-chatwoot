import { z } from "zod";
import { db } from "@/lib/db";
import type { Autor, Desfecho } from "@/server/gestao/autor";
import { listarIntegracoes } from "@/server/integrations/registry";
import type {
  IntegrationDefinition,
  ToolDefinition,
} from "@/server/integrations/types";
import type { ContextoMcp } from "../executor";
import { recusar, responder } from "../formato";
import type { ResultadoDeFerramenta } from "../protocolo";

export const campoAgente = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Chave (key), id ou nome exato do agente. Prefira a chave: ela não muda quando o agente é renomeado.",
  );

/** Toda alteração pelo MCP sai em nome da pessoa dona do token, marcada como MCP. */
export function autorDoMcp(ctx: ContextoMcp): Autor {
  return {
    userId: ctx.usuario.id,
    nome: ctx.usuario.nome,
    mcp: { tokenId: ctx.tokenId },
  };
}

export function traduzirDesfecho(
  desfecho: Desfecho,
  extra: Record<string, unknown> = {},
): ResultadoDeFerramenta {
  if ("erro" in desfecho) return recusar(desfecho.erro);
  return responder({
    ok: desfecho.ok,
    ...(desfecho.aviso ? { aviso: desfecho.aviso } : {}),
    ...extra,
  });
}

/**
 * Acha o agente por id, chave ou nome — nessa ordem, para um nome que coincida
 * com a chave de OUTRO agente não trocar o alvo de uma alteração.
 */
export async function acharAgente(termo: string) {
  const t = termo.trim();
  return (
    (await db.agent.findUnique({ where: { id: t } })) ??
    (await db.agent.findUnique({ where: { key: t } })) ??
    (await db.agent.findFirst({
      where: { name: { equals: t, mode: "insensitive" } },
    }))
  );
}

/**
 * A recusa já traz as chaves que existem: o assistente se corrige na chamada
 * seguinte em vez de adivinhar de novo.
 */
export async function agenteNaoEncontrado(
  termo: string,
): Promise<ResultadoDeFerramenta> {
  const agentes = await db.agent.findMany({
    orderBy: { name: "asc" },
    select: { key: true, name: true, archivedAt: true },
  });
  return recusar(`Nenhum agente com chave, id ou nome "${termo}".`, {
    agentesExistentes: agentes.map((a) => ({
      key: a.key,
      nome: a.name,
      ...(a.archivedAt ? { arquivado: true } : {}),
    })),
  });
}

export function localizarFerramenta(
  nome: string,
): { definicao: ToolDefinition; integracao: IntegrationDefinition } | null {
  for (const integracao of listarIntegracoes()) {
    const definicao = integracao.tools.find((t) => t.name === nome);
    if (definicao) return { definicao, integracao };
  }
  return null;
}

export function nomesDoCatalogo(): Set<string> {
  return new Set(
    listarIntegracoes().flatMap((i) => i.tools.map((t) => t.name)),
  );
}

/** O serviço aponta o campo pelo nome do banco; o assistente mandou em português. */
const NOMES_DOS_CAMPOS: Record<string, string> = {
  name: "nome",
  description: "descricao",
  systemPrompt: "prompt",
  model: "modelo",
  effort: "effort",
  maxTokens: "maxTokens",
  maxToolIterations: "maxToolIterations",
  routingDescription: "descricaoDeRoteamento",
};

export function camposEmPortugues(
  campos: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!campos) return undefined;
  return Object.fromEntries(
    Object.entries(campos).map(([k, v]) => [NOMES_DOS_CAMPOS[k] ?? k, v]),
  );
}
