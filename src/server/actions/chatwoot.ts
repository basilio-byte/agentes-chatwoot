"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import {
  IntegrationProvider,
  IntegrationStatus,
  UserRole,
} from "@/generated/prisma/enums";
import {
  chatwootConfigSchema,
  chatwootSegredosSchema,
} from "@/server/integrations/chatwoot/config";
import {
  clienteDoAgente,
  obterConfigChatwoot,
  salvarSegredosDoBot,
} from "@/server/integrations/chatwoot/credenciais";

export type EstadoChatwoot = {
  ok?: string;
  erro?: string;
  camposComErro?: Record<string, string>;
};

/** Config da instância — vale para todos os agentes. */
export async function salvarConfigChatwoot(
  _estado: EstadoChatwoot,
  formData: FormData,
): Promise<EstadoChatwoot> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const parsed = chatwootConfigSchema.safeParse({
    baseUrl: formData.get("baseUrl"),
    accountId: formData.get("accountId"),
  });

  if (!parsed.success) {
    return {
      erro: "Confira os campos.",
      camposComErro: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join("."), i.message]),
      ),
    };
  }

  await db.integration.upsert({
    where: { provider: IntegrationProvider.CHATWOOT },
    update: { config: parsed.data, enabled: formData.get("enabled") === "on" },
    create: {
      provider: IntegrationProvider.CHATWOOT,
      label: "Chatwoot",
      config: parsed.data,
      enabled: formData.get("enabled") === "on",
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.chatwoot.updated",
      entity: "Integration",
      entityId: IntegrationProvider.CHATWOOT,
    },
  });

  revalidatePath("/integracoes");
  return { ok: "Configuração salva." };
}

/**
 * Bot de um agente. Credencial é coisa de OWNER.
 */
export async function salvarBotDoAgente(
  agentId: string,
  _estado: EstadoChatwoot,
  formData: FormData,
): Promise<EstadoChatwoot> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const botName = String(formData.get("botName") ?? "").trim();
  if (botName.length < 2) {
    return {
      erro: "Confira os campos.",
      camposComErro: { botName: "Informe o nome do bot" },
    };
  }

  const botIdCru = String(formData.get("botId") ?? "").trim();
  const botId = botIdCru ? Number(botIdCru) : null;
  if (botIdCru && !Number.isInteger(botId)) {
    return {
      erro: "Confira os campos.",
      camposComErro: { botId: "Deve ser um número inteiro" },
    };
  }

  const parsed = chatwootSegredosSchema.safeParse({
    token: formData.get("token"),
    webhookSecret: formData.get("webhookSecret") ?? "",
  });

  if (!parsed.success) {
    return {
      erro: "Confira os campos.",
      camposComErro: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join("."), i.message]),
      ),
    };
  }

  await salvarSegredosDoBot({
    agentId,
    botName,
    botId,
    segredos: parsed.data,
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "agent.chatwoot_bot.rotated",
      entity: "Agent",
      entityId: agentId,
    },
  });

  revalidatePath(`/agentes/${agentId}`);
  return { ok: "Bot salvo. Use o botão de testar para confirmar." };
}

/** Testa config + token do bot contra a instância real. */
export async function testarConexaoDoAgente(
  agentId: string,
): Promise<EstadoChatwoot> {
  await exigirPapel(UserRole.ADMIN);

  const cliente = await clienteDoAgente(agentId);
  if (!cliente) {
    return {
      erro:
        "Falta configuração: confira a URL e o id da conta em Integrações, e o token do bot aqui.",
    };
  }

  const resultado = await cliente.testar();

  await db.integration.update({
    where: { provider: IntegrationProvider.CHATWOOT },
    data: {
      status: resultado.ok ? IntegrationStatus.OK : IntegrationStatus.ERROR,
      lastCheckedAt: new Date(),
      lastError: resultado.ok ? null : resultado.mensagem,
    },
  });

  revalidatePath("/integracoes");
  revalidatePath(`/agentes/${agentId}`);

  return resultado.ok
    ? { ok: resultado.mensagem }
    : { erro: resultado.mensagem };
}

/** Só para a tela: nunca devolve o segredo em si. */
export async function resumoDoBot(agentId: string) {
  const [bot, { config, habilitada }] = await Promise.all([
    db.agentChatwootBot.findUnique({ where: { agentId } }),
    obterConfigChatwoot(),
  ]);

  return {
    configurado: Boolean(bot),
    botName: bot?.botName ?? "",
    botId: bot?.botId ?? null,
    hint: bot?.hint ?? null,
    rotatedAt: bot?.rotatedAt ?? null,
    instanciaOk: Boolean(config),
    habilitadaGlobalmente: habilitada,
  };
}
