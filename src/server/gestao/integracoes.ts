import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import type { IntegrationProvider } from "@/generated/prisma/enums";
import { obterIntegracao } from "@/server/integrations/registry";
import { auditar, type Autor, type Desfecho } from "./autor";

/**
 * O toggle de dois níveis e a allowlist — a regra, sem a porta.
 *
 * O que vai para o modelo é a interseção de `Integration.enabled` (global) com
 * `AgentIntegration.enabled` + `allowedTools` (por agente). Quem resolve essa
 * interseção na hora do turno é `resolve.ts`; aqui só se grava.
 */

/**
 * Liga ou desliga uma integração para TODOS os agentes.
 *
 * Só o `enabled`: config e credencial ficam onde estão. O painel faz isto pelo
 * formulário de configuração de cada integração, que grava config e toggle
 * juntos; o MCP não mexe em config, então tem esta porta própria.
 */
export async function definirIntegracaoGlobal(
  provider: IntegrationProvider,
  ligar: boolean,
  autor: Autor,
): Promise<Desfecho> {
  const definicao = obterIntegracao(provider);
  if (!definicao) {
    return { erro: "Esta integração não tem implementação no sistema." };
  }

  const integracao = await db.integration.findUnique({
    where: { provider },
    select: { enabled: true, credential: { select: { id: true } } },
  });
  if (!integracao) {
    return {
      erro: "Esta integração nunca foi configurada. A configuração inicial é feita em Integrações, no painel.",
    };
  }

  if (integracao.enabled === ligar) {
    return {
      ok: ligar ? "A integração já estava ligada." : "A integração já estava desligada.",
    };
  }

  await db.integration.update({ where: { provider }, data: { enabled: ligar } });

  await auditar(
    autor,
    ligar ? "integration.enabled" : "integration.disabled",
    "Integration",
    provider,
  );

  revalidatePath("/integracoes");

  if (!ligar) {
    return { ok: "Desligada para todos os agentes, a partir do próximo turno." };
  }

  // Credencial é coisa de OWNER e fica fora do MCP. Ligar sem ela não quebra
  // nada na hora — quebra no primeiro turno que precisar dela.
  if (definicao.credentialLabel && !integracao.credential) {
    return {
      ok: "Ligada. Cada agente só a usa se também a tiver ligada na tela dele.",
      aviso:
        "Não há credencial cadastrada: ela vai falhar até o Proprietário cadastrar a credencial no painel.",
    };
  }
  return { ok: "Ligada. Cada agente só a usa se também a tiver ligada na tela dele." };
}

/** Estado do segundo nível — a tela alterna a partir dele. */
export async function integracaoLigadaNoAgente(
  agentId: string,
  provider: IntegrationProvider,
): Promise<boolean> {
  const vinculo = await db.agentIntegration.findFirst({
    where: { agentId, integration: { provider } },
    select: { enabled: true },
  });
  return vinculo?.enabled ?? false;
}

/**
 * Liga ou desliga uma integração **para um agente**.
 *
 * É o segundo nível do toggle: mesmo com a integração ligada globalmente, o
 * agente só enxerga as tools se estiver ligada aqui também.
 */
export async function definirIntegracaoDoAgente(
  agentId: string,
  provider: IntegrationProvider,
  ligar: boolean,
  autor: Autor,
): Promise<Desfecho> {
  const integracao = await db.integration.findUnique({ where: { provider } });
  if (!integracao) {
    return { erro: "Configure a integração em Integrações antes de ligá-la aqui." };
  }

  const agente = await db.agent.findUnique({
    where: { id: agentId },
    select: { id: true },
  });
  if (!agente) return { erro: "Agente não encontrado." };

  await db.agentIntegration.upsert({
    where: { agentId_integrationId: { agentId, integrationId: integracao.id } },
    update: { enabled: ligar },
    create: { agentId, integrationId: integracao.id, enabled: ligar },
  });

  await auditar(
    autor,
    ligar ? "agent.integration.enabled" : "agent.integration.disabled",
    "Agent",
    agentId,
    { provider },
  );

  revalidatePath(`/agentes/${agentId}`);

  if (ligar && !integracao.enabled) {
    return {
      ok: "Ligada para este agente — mas a integração está desligada globalmente, então as tools ainda não aparecem.",
    };
  }
  return { ok: ligar ? "Integração ligada para este agente." : "Desligada." };
}

/**
 * Define quais tools o agente pode usar.
 *
 * ⚠ No banco, `allowedTools` vazio significa TODAS, não nenhuma. Por isso uma
 * lista sem nenhum nome válido é RECUSADA: até 11/09/2026 o "Desmarcar todas"
 * da tela salvava `[]`, e o agente passava a enxergar todas as ferramentas da
 * integração — o contrário exato do que a pessoa pediu, sem erro nenhum. Para
 * um agente ficar sem ferramenta de uma integração, desliga-se a integração
 * para ele.
 */
export async function definirFerramentasDoAgente(
  agentId: string,
  provider: IntegrationProvider,
  tools: string[],
  autor: Autor,
): Promise<Desfecho> {
  const definicao = obterIntegracao(provider);
  const integracao = await db.integration.findUnique({ where: { provider } });
  if (!definicao || !integracao) {
    return { erro: "Integração não encontrada." };
  }

  const agente = await db.agent.findUnique({
    where: { id: agentId },
    select: { id: true },
  });
  if (!agente) return { erro: "Agente não encontrado." };

  const validas = new Set(definicao.tools.map((t) => t.name));
  // Sem repetição: um nome duplicado contaria duas vezes e faria uma seleção
  // parcial parecer "todas".
  const filtradas = [...new Set(tools.filter((t) => validas.has(t)))];

  if (filtradas.length === 0) {
    return {
      erro: "Nenhuma ferramenta marcada. Para este agente ficar sem nenhuma ferramenta desta integração, desligue a integração para ele.",
    };
  }

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

  await auditar(autor, "agent.tools.updated", "Agent", agentId, {
    provider,
    ferramentas: guardar,
  });

  revalidatePath(`/agentes/${agentId}`);
  return {
    ok:
      guardar.length === 0
        ? "Todas as ferramentas liberadas."
        : `${guardar.length} ferramenta(s) liberada(s).`,
  };
}
