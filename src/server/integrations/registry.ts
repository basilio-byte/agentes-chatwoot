import type { IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition } from "./types";
import { chatwootIntegration } from "./chatwoot";
import { clickupIntegration } from "./clickup";

/**
 * Registro central de integrações.
 *
 * O ERP Conexa continua fora: a documentação de API dele ainda não foi
 * fornecida, e inventar endpoints garantiria retrabalho.
 *
 * Para adicionar uma integração:
 *   1. criar `src/server/integrations/<provider>/index.ts` exportando um
 *      `IntegrationDefinition`;
 *   2. adicionar a entrada aqui;
 *   3. configurar pelo painel.
 */
const definicoes: Partial<Record<IntegrationProvider, IntegrationDefinition>> = {
  [chatwootIntegration.provider]: chatwootIntegration,
  [clickupIntegration.provider]: clickupIntegration,
};

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
