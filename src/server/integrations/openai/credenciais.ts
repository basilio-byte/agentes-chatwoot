import { db } from "@/lib/db";
import { cifrar, decifrar } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { IntegrationProvider } from "@/generated/prisma/enums";
import { lerConfigOpenAI, type OpenAIConfig } from "./config";
import { criarClienteOpenAI } from "./client";
import { limparCacheDeModelos } from "./catalogo";
import type { ContextoDaAnalise } from "./analise";

/**
 * Resolve se a leitura de mídia está disponível — e para quem.
 *
 * O toggle é o mesmo de duas alturas de qualquer integração:
 *   1. `Integration.enabled`      — global
 *   2. `AgentIntegration.enabled` — por agente
 *
 * ⚠ O agente que decide é a **PORTA** (o dono do bot pelo qual a conversa
 * entrou), não quem está pensando no momento. Dois motivos:
 *
 *  - o webhook precisa decidir se agenda uma mensagem que só tem anexo, e lá
 *    ainda não se sabe quem vai pensar (pode ser um especialista que assumiu);
 *  - a transcrição é da CONVERSA, não do pensador: um colega que recebe a
 *    conversa por transferência lê o mesmo histórico, e não faria sentido o
 *    áudio sumir do contexto no meio do atendimento.
 *
 * Sem essa regra, porta e pensador poderiam discordar, e a mensagem seria
 * agendada por um e ignorada pelo outro — silêncio, de novo.
 */

export type CapacidadeDeMidia = {
  ligada: boolean;
  /** Por que não está ligada, em texto para humano. */
  motivo?: string;
  config: OpenAIConfig;
  apiKey?: string;
};

export async function capacidadeDeMidia(
  agentId: string | null | undefined,
): Promise<CapacidadeDeMidia> {
  const integracao = await db.integration.findUnique({
    where: { provider: IntegrationProvider.OPENAI },
    include: { credential: true },
  });

  const config = lerConfigOpenAI(integracao?.config);

  if (!integracao) {
    return { ligada: false, motivo: "leitura de mídia não configurada", config };
  }
  if (!integracao.enabled) {
    return {
      ligada: false,
      motivo: "leitura de mídia desligada globalmente, em Integrações",
      config,
    };
  }
  if (!integracao.credential) {
    return {
      ligada: false,
      motivo: "leitura de mídia sem chave da OpenAI cadastrada",
      config,
    };
  }

  if (!agentId) {
    return { ligada: false, motivo: "sem agente para conferir o toggle", config };
  }

  const vinculo = await db.agentIntegration.findUnique({
    where: {
      agentId_integrationId: { agentId, integrationId: integracao.id },
    },
    select: { enabled: true },
  });

  if (!vinculo?.enabled) {
    return {
      ligada: false,
      motivo: "leitura de mídia desligada para o agente desta caixa de entrada",
      config,
    };
  }

  let apiKey: string;
  try {
    apiKey = decifrar(integracao.credential);
  } catch (erro) {
    logger.error({ erro }, "não consegui decifrar a chave da OpenAI");
    return {
      ligada: false,
      motivo: "chave da OpenAI ilegível — recadastre em Integrações",
      config,
    };
  }

  return { ligada: true, config, apiKey };
}

/** Só o "está ligada?", para o webhook decidir sem carregar credencial. */
export async function leituraDeMidiaLigada(
  agentId: string | null | undefined,
): Promise<{ ligada: boolean; motivo?: string }> {
  const { ligada, motivo } = await capacidadeDeMidia(agentId);
  return { ligada, motivo };
}

/** Contexto pronto para `analisarAnexo`. `null` quando a capacidade está off. */
export async function contextoDeMidia(args: {
  agentId: string;
  conversationId?: string | null;
  chatwootBaseUrl?: string | null;
  chatwootToken?: string | null;
}): Promise<(ContextoDaAnalise & { config: OpenAIConfig }) | null> {
  const capacidade = await capacidadeDeMidia(args.agentId);
  if (!capacidade.ligada || !capacidade.apiKey) return null;

  return {
    cliente: criarClienteOpenAI(capacidade.config, capacidade.apiKey),
    config: capacidade.config,
    chatwootBaseUrl: args.chatwootBaseUrl,
    chatwootToken: args.chatwootToken,
    agentId: args.agentId,
    conversationId: args.conversationId,
  };
}

/**
 * Guarda a chave e **esvazia o cache de modelos**.
 *
 * A chave nova pode ser de outra conta, e oferecer no seletor os modelos da
 * conta anterior é pior do que não oferecer nenhum: o operador escolheria um id
 * que não existe e só descobriria no primeiro áudio de cliente.
 */
export async function salvarChaveOpenAI(apiKey: string) {
  limparCacheDeModelos();

  const integracao = await db.integration.upsert({
    where: { provider: IntegrationProvider.OPENAI },
    update: {},
    create: {
      provider: IntegrationProvider.OPENAI,
      label: "OpenAI — leitura de mídia",
      config: {},
      enabled: false,
    },
  });

  const cifrado = cifrar(apiKey);
  await db.integrationCredential.upsert({
    where: { integrationId: integracao.id },
    update: { ...cifrado, rotatedAt: new Date() },
    create: { integrationId: integracao.id, ...cifrado },
  });
}
