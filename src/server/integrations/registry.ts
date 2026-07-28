import type { IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition } from "./types";

/**
 * Registro central de integrações.
 *
 * Vazio de propósito nesta fase: a documentação de API do ClickUp e do ERP Conexa
 * ainda não foi fornecida, e as tools do Chatwoot entram na Fase 2. Inventar
 * endpoints agora garantiria retrabalho.
 *
 * Para adicionar uma integração:
 *   1. criar `src/server/integrations/<provider>/index.ts` exportando um
 *      `IntegrationDefinition`;
 *   2. adicionar a entrada aqui;
 *   3. rodar o seed (ou criar a linha em `Integration` pelo painel).
 */
const definicoes: Partial<Record<IntegrationProvider, IntegrationDefinition>> =
  {};

export function listarIntegracoes(): IntegrationDefinition[] {
  return Object.values(definicoes).filter(Boolean) as IntegrationDefinition[];
}

export function obterIntegracao(
  provider: IntegrationProvider,
): IntegrationDefinition | null {
  return definicoes[provider] ?? null;
}

export function integracaoImplementada(provider: IntegrationProvider): boolean {
  return provider in definicoes;
}
