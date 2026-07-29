"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { obterIntegracao } from "@/server/integrations/registry";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";

export type EstadoIntegracaoAgente = { ok?: string; erro?: string };

/**
 * Liga ou desliga uma integração **para um agente**.
 *
 * É o segundo nível do toggle: mesmo com a integração ligada globalmente, o
 * agente só enxerga as tools se estiver ligada aqui também.
 */
export async function alternarIntegracaoDoAgente(
  agentId: string,
  provider: IntegrationProvider,
): Promise<EstadoIntegracaoAgente> {
  await exigirPapel(UserRole.ADMIN);

  const integracao = await db.integration.findUnique({ where: { provider } });
  if (!integracao) {
    return { erro: "Configure a integração em Integrações antes de ligá-la aqui." };
  }

  const atual = await db.agentIntegration.findUnique({
    where: { agentId_integrationId: { agentId, integrationId: integracao.id } },
  });

  const ligada = !atual?.enabled;

  await db.agentIntegration.upsert({
    where: { agentId_integrationId: { agentId, integrationId: integracao.id } },
    update: { enabled: ligada },
    create: { agentId, integrationId: integracao.id, enabled: ligada },
  });

  revalidatePath(`/agentes/${agentId}`);

  if (ligada && !integracao.enabled) {
    return {
      ok: "Ligada para este agente — mas a integração está desligada globalmente, então as tools ainda não aparecem.",
    };
  }
  return { ok: ligada ? "Integração ligada para este agente." : "Desligada." };
}

/**
 * Define quais tools o agente pode usar. Lista vazia = todas.
 *
 * Serve para dar a um agente de atendimento só o que ele precisa: consultar sem
 * poder alterar, por exemplo.
 */
export async function definirToolsPermitidas(
  agentId: string,
  provider: IntegrationProvider,
  tools: string[],
): Promise<EstadoIntegracaoAgente> {
  await exigirPapel(UserRole.ADMIN);

  const definicao = obterIntegracao(provider);
  const integracao = await db.integration.findUnique({ where: { provider } });
  if (!definicao || !integracao) {
    return { erro: "Integração não encontrada." };
  }

  const validas = new Set(definicao.tools.map((t) => t.name));
  const filtradas = tools.filter((t) => validas.has(t));

  // Selecionar todas equivale a não restringir — guardar vazio evita que a
  // allowlist congele e esconda tools novas de versões futuras.
  const guardar = filtradas.length === validas.size ? [] : filtradas;

  await db.agentIntegration.upsert({
    where: { agentId_integrationId: { agentId, integrationId: integracao.id } },
    update: { allowedTools: guardar },
    create: {
      agentId,
      integrationId: integracao.id,
      enabled: true,
      allowedTools: guardar,
    },
  });

  revalidatePath(`/agentes/${agentId}`);
  return {
    ok:
      guardar.length === 0
        ? "Todas as ferramentas liberadas."
        : `${guardar.length} ferramenta(s) liberada(s).`,
  };
}
