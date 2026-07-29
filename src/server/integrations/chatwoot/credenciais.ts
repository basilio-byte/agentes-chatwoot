import { db } from "@/lib/db";
import { cifrar, decifrar } from "@/lib/crypto";
import { IntegrationProvider } from "@/generated/prisma/enums";
import {
  chatwootConfigSchema,
  chatwootSegredosSchema,
  type ChatwootConfig,
  type ChatwootSegredos,
} from "./config";
import { ChatwootClient } from "./client";

/** Config da instância + se a integração está ligada no nível global. */
export async function obterConfigChatwoot(): Promise<{
  config: ChatwootConfig | null;
  habilitada: boolean;
}> {
  const registro = await db.integration.findUnique({
    where: { provider: IntegrationProvider.CHATWOOT },
  });
  if (!registro) return { config: null, habilitada: false };

  const parsed = chatwootConfigSchema.safeParse(registro.config);
  return {
    config: parsed.success ? parsed.data : null,
    habilitada: registro.enabled,
  };
}

/**
 * Secret do webhook **de conta** (Configurações → Integrações → Webhooks).
 *
 * Separado do secret de cada bot: é esse canal que entrega
 * `conversation_status_changed`, evento que o webhook de Agent Bot pode não
 * receber. Sem ele as regras continuam valendo (o worker checa ao vivo), mas o
 * corte de histórico só acontece quando alguém escreve na conversa.
 */
export async function salvarSecretDaConta(secret: string) {
  const integracao = await db.integration.upsert({
    where: { provider: IntegrationProvider.CHATWOOT },
    update: {},
    create: {
      provider: IntegrationProvider.CHATWOOT,
      label: "Chatwoot",
      config: {},
      enabled: false,
    },
  });

  const cifrado = cifrar(secret);
  await db.integrationCredential.upsert({
    where: { integrationId: integracao.id },
    update: { ...cifrado, rotatedAt: new Date() },
    create: { integrationId: integracao.id, ...cifrado },
  });
}

export async function obterSecretDaConta(): Promise<string | null> {
  const integracao = await db.integration.findUnique({
    where: { provider: IntegrationProvider.CHATWOOT },
    include: { credential: true },
  });
  if (!integracao?.credential) return null;

  try {
    return decifrar(integracao.credential);
  } catch {
    return null;
  }
}

export async function salvarSegredosDoBot(args: {
  agentId: string;
  botName: string;
  botId?: number | null;
  segredos: ChatwootSegredos;
}) {
  const cifrado = cifrar(JSON.stringify(args.segredos));

  // Liga a integração para este agente, senão a tool de transferência não
  // apareceria para o modelo. O toggle por agente continua editável depois.
  const integracao = await db.integration.findUnique({
    where: { provider: IntegrationProvider.CHATWOOT },
    select: { id: true },
  });

  if (integracao) {
    await db.agentIntegration.upsert({
      where: {
        agentId_integrationId: {
          agentId: args.agentId,
          integrationId: integracao.id,
        },
      },
      update: {},
      create: {
        agentId: args.agentId,
        integrationId: integracao.id,
        enabled: true,
      },
    });
  }

  return db.agentChatwootBot.upsert({
    where: { agentId: args.agentId },
    update: {
      botName: args.botName,
      botId: args.botId ?? null,
      ciphertext: cifrado.ciphertext,
      iv: cifrado.iv,
      authTag: cifrado.authTag,
      hint: cifrar(args.segredos.token).hint,
      rotatedAt: new Date(),
    },
    create: {
      agentId: args.agentId,
      botName: args.botName,
      botId: args.botId ?? null,
      ciphertext: cifrado.ciphertext,
      iv: cifrado.iv,
      authTag: cifrado.authTag,
      hint: cifrar(args.segredos.token).hint,
    },
  });
}

/** Decifra os segredos do bot de um agente. `null` se ele não tem bot. */
export async function obterSegredosDoBot(
  agentId: string,
): Promise<ChatwootSegredos | null> {
  const bot = await db.agentChatwootBot.findUnique({ where: { agentId } });
  if (!bot) return null;

  const parsed = chatwootSegredosSchema.safeParse(
    JSON.parse(decifrar(bot)),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Cliente pronto para o agente: junta a config global com o token do bot dele.
 * `null` quando falta qualquer uma das duas pontas.
 */
export async function clienteDoAgente(
  agentId: string,
): Promise<ChatwootClient | null> {
  const [{ config }, segredos, bot] = await Promise.all([
    obterConfigChatwoot(),
    obterSegredosDoBot(agentId),
    db.agentChatwootBot.findUnique({
      where: { agentId },
      select: { accountId: true },
    }),
  ]);

  if (!config || !segredos) return null;

  // A conta do bot sobrescreve a da configuração global: a instância é a mesma,
  // mas cada agente pode viver numa conta diferente do Chatwoot.
  return new ChatwootClient(
    { ...config, accountId: bot?.accountId ?? config.accountId },
    segredos.token,
  );
}
