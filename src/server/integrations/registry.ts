import type { IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition } from "./types";
import { chatwootIntegration } from "./chatwoot";
import { clickupIntegration } from "./clickup";
import { conexaIntegration } from "./conexa";
import { zapsignIntegration } from "./zapsign";

/**
 * Registro central de integrações.
 *
 * A ClickSign ainda está fora: o cliente HTTP existe e tem teste, mas falta o
 * catálogo de tools e o valor no enum `IntegrationProvider`.
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
  [conexaIntegration.provider]: conexaIntegration,
  [zapsignIntegration.provider]: zapsignIntegration,
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
