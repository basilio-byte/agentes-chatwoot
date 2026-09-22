import type { IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition } from "./types";
import { chatwootIntegration } from "./chatwoot";
import { clickupIntegration } from "./clickup";
import { conexaIntegration } from "./conexa";
import { documentosIntegration } from "@/server/documentos";
import { googleIntegration } from "./google";
import { openaiIntegration } from "./openai";
import { zapsignIntegration } from "./zapsign";
import { prazosIntegration } from "./prazos";
import { materiaisIntegration } from "./materiais";
import { aniversarioIntegration } from "./aniversario";

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
  // Zero tools de propósito: prepara o contexto (áudio/imagem/documento viram
  // texto) em vez de dar uma ferramenta ao modelo. Ver `openai/index.ts`.
  [openaiIntegration.provider]: openaiIntegration,
  // Sem credencial: algoritmo público e consulta gratuita. Está aqui pelo
  // toggle de dois níveis e pela allowlist, não por ter conta para configurar.
  [documentosIntegration.provider]: documentosIntegration,
  // Sheets, Docs e Drive num provider só: a credencial é uma (a chave da conta
  // de serviço) e `IntegrationCredential` é 1:1 com `Integration`. Três
  // providers obrigariam a colar o mesmo JSON três vezes e a rotacioná-lo em
  // três lugares — e o primeiro esquecido falharia sozinho, com os outros dois
  // funcionando. Quem separa Sheets de Docs para o operador é `categoria`.
  [googleIntegration.provider]: googleIntegration,
  // Sem credencial e sem terceiro: o agente registra um prazo na conversa e o
  // vigia executa. Provider próprio para ser opt-in por agente.
  [prazosIntegration.provider]: prazosIntegration,
  // Imagens dos macros do Chatwoot, pelo robô da conversa. Provider próprio,
  // como os Prazos, para mandar arquivo ao cliente ser opt-in por agente.
  [materiaisIntegration.provider]: materiaisIntegration,
  // O agente registra o pedido do presente e o vigia reserva quando o pacote
  // aparece pago. Provider próprio para ser opt-in por agente.
  [aniversarioIntegration.provider]: aniversarioIntegration,
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
