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
  salvarSegredosDaConta,
  salvarSegredosDoBot,
} from "@/server/integrations/chatwoot/credenciais";
import { lerIdsDeCaixa } from "@/server/agents/equipe";
import { autorDaSessao } from "@/server/gestao/autor";
import { salvarEscopo } from "@/server/gestao/escopo";

export type EstadoEscopo = { ok?: string; erro?: string };

export type EstadoChatwoot = {
  ok?: string;
  erro?: string;
  /** Nem sucesso nem falha — ver ResultadoTeste.indeterminado. */
  aviso?: string;
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

  // Campo em branco mantém o valor atual — o formulário nunca devolve o segredo.
  await salvarSegredosDaConta({
    secretDaConta: String(formData.get("secretDaConta") ?? ""),
    tokenDeLeitura: String(formData.get("tokenDeLeitura") ?? ""),
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

  // Indeterminado não marca a integração como quebrada: token de Agent Bot
  // recusado num endpoint de usuário não é defeito de configuração.
  const status = resultado.ok
    ? IntegrationStatus.OK
    : resultado.indeterminado
      ? IntegrationStatus.NOT_CONFIGURED
      : IntegrationStatus.ERROR;

  await db.integration.update({
    where: { provider: IntegrationProvider.CHATWOOT },
    data: {
      status,
      lastCheckedAt: new Date(),
      lastError: resultado.ok || resultado.indeterminado ? null : resultado.mensagem,
    },
  });

  revalidatePath("/integracoes");
  revalidatePath(`/agentes/${agentId}`);

  if (resultado.ok) return { ok: resultado.mensagem };
  return resultado.indeterminado
    ? { aviso: resultado.mensagem }
    : { erro: resultado.mensagem };
}

/** Só para a tela: nunca devolve o segredo em si. */
/**
 * Onde o agente atua: conta do Chatwoot e caixas de entrada.
 *
 * A conta fica no bot (é dele o token que fala com aquela conta); o escopo de
 * caixas fica no agente, porque vale também para o roteamento e para o roster —
 * um colega que não atua na caixa não deve nem aparecer para transferência.
 */
export async function salvarEscopoDoAgente(
  agentId: string,
  _estado: EstadoEscopo,
  formData: FormData,
): Promise<EstadoEscopo> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  // Aqui só se lê o formulário. Texto que não vira número segue como `NaN` e é
  // recusado pelo serviço, com a mesma frase e na mesma ordem de antes — a
  // regra mora em `server/gestao/escopo.ts`, que o MCP também chama.
  const contaBruta = String(formData.get("accountId") ?? "").trim();
  const minutosBruto = String(formData.get("fallbackMinutos") ?? "").trim();

  return salvarEscopo(
    agentId,
    {
      inboxMode: String(formData.get("inboxMode") ?? "all"),
      inboxIds: lerIdsDeCaixa(String(formData.get("inboxIds") ?? "")),
      accountId: contaBruta ? Number.parseInt(contaBruta, 10) : null,
      fallbackMinutos: minutosBruto ? Number.parseInt(minutosBruto, 10) : null,
      fallbackAtendente: String(formData.get("fallbackAtendente") ?? ""),
    },
    autorDaSessao(sessao),
  );
}

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
