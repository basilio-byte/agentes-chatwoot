import { db } from "@/lib/db";
import { decifrar } from "@/lib/crypto";
import { IntegrationProvider } from "@/generated/prisma/enums";
import { clickupIntegration } from "@/server/integrations/clickup";
import { ClickUpClient } from "@/server/integrations/clickup/client";
import {
  clickupConfigSchema,
  type ClickUpConfig,
} from "@/server/integrations/clickup/config";
import type { ToolContext } from "@/server/integrations/types";

/**
 * O ClickUp aberto pelo SISTEMA, sem modelo no meio.
 *
 * Mora aqui, e não dentro de quem usa, porque já são dois: a pesquisa de
 * satisfação grava a nota e o vigia dos prazos troca o responsável da task. A
 * parte que se duplicaria é a mais perigosa — decifrar credencial e montar o
 * contexto das ferramentas —, e cópia de credencial é a que fica para trás numa
 * rotação.
 *
 * ⚠ Desligado no painel é desligado para o sistema também.
 */
export type ClickUpDoSistema = {
  cliente: ClickUpClient;
  config: ClickUpConfig;
  executar: (ferramenta: string, entrada: unknown) => Promise<unknown>;
};

export async function abrirClickUp(
  quemChama: string,
): Promise<ClickUpDoSistema | { erro: string }> {
  const integracao = await db.integration.findUnique({
    where: { provider: IntegrationProvider.CLICKUP },
    include: { credential: true },
  });
  // Desligado no painel é desligado para todo mundo, inclusive para o sistema.
  if (!integracao?.enabled) return { erro: "a integração do ClickUp está desligada" };
  if (!integracao.credential) return { erro: "o ClickUp está sem token" };

  const config = clickupConfigSchema.safeParse(integracao.config);
  if (!config.success) return { erro: "a configuração do ClickUp está incompleta" };

  let credential: string;
  try {
    credential = decifrar(integracao.credential);
  } catch {
    return { erro: "não consegui decifrar o token do ClickUp" };
  }

  const ctx: ToolContext = {
    provider: IntegrationProvider.CLICKUP,
    config: integracao.config as Record<string, unknown>,
    credential,
    // Nenhuma ferramenta do ClickUp lê o agente: o rótulo só diz quem chamou.
    agentId: `sistema-${quemChama}`,
  };

  return {
    cliente: new ClickUpClient(credential),
    config: config.data,
    async executar(ferramenta, entrada) {
      const definicao = clickupIntegration.tools.find((t) => t.name === ferramenta);
      if (!definicao) throw new Error(`a ferramenta ${ferramenta} não existe`);
      return definicao.execute(definicao.inputSchema.parse(entrada), ctx);
    },
  };
}

