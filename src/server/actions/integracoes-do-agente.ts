"use server";

import { exigirPapel } from "@/server/auth-guard";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { autorDaSessao } from "@/server/gestao/autor";
import {
  definirFerramentasDoAgente,
  definirIntegracaoDoAgente,
  integracaoLigadaNoAgente,
} from "@/server/gestao/integracoes";

// A regra mora em `server/gestao/integracoes.ts`, que o MCP também chama.

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
  const sessao = await exigirPapel(UserRole.ADMIN);
  const ligada = await integracaoLigadaNoAgente(agentId, provider);
  return definirIntegracaoDoAgente(
    agentId,
    provider,
    !ligada,
    autorDaSessao(sessao),
  );
}

/**
 * Define quais tools o agente pode usar. Todas marcadas = sem restrição.
 *
 * Serve para dar a um agente de atendimento só o que ele precisa: consultar sem
 * poder alterar, por exemplo.
 */
export async function definirToolsPermitidas(
  agentId: string,
  provider: IntegrationProvider,
  tools: string[],
): Promise<EstadoIntegracaoAgente> {
  const sessao = await exigirPapel(UserRole.ADMIN);
  return definirFerramentasDoAgente(
    agentId,
    provider,
    tools,
    autorDaSessao(sessao),
  );
}
