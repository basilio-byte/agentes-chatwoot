import type { IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition } from "./types";
import { chatwootIntegration } from "./chatwoot";
import { clickupIntegration } from "./clickup";
import { conexaIntegration } from "./conexa";
import { zapsignIntegration } from "./zapsign";

/**
 * Registro central de integrações.
 *
 * A ClickSign foi cancelada em 03/08/2026 e saiu do repositório — está no
 * histórico do git se algum dia voltar.
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
