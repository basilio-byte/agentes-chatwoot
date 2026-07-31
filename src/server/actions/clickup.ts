"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { cifrar, decifrar } from "@/lib/crypto";
import { exigirPapel } from "@/server/auth-guard";
import {
  IntegrationProvider,
  IntegrationStatus,
  UserRole,
} from "@/generated/prisma/enums";
import { clickupConfigSchema } from "@/server/integrations/clickup/config";
import { ClickUpClient } from "@/server/integrations/clickup/client";

export type EstadoClickUp = {
  ok?: string;
  erro?: string;
  camposComErro?: Record<string, string>;
};

async function registro() {
  return db.integration.findUnique({
    where: { provider: IntegrationProvider.CLICKUP },
    include: { credential: true },
  });
}

/**
 * Lê o campo de listas nomeadas: uma por linha, no formato `nome = id`.
 *
 * Linha malformada é descartada em silêncio em vez de travar o salvamento —
 * perder a configuração inteira por causa de uma linha meio digitada seria
 * pior do que ignorar essa linha.
 */
function lerListasNomeadas(texto: string) {
  return texto
    .split(/[\r\n]+/)
    .map((linha) => {
      const [nome, ...resto] = linha.split("=");
      const listId = resto.join("=").trim();
      return { nome: nome.trim(), listId };
    })
    .filter((l) => l.nome && l.listId);
}

export async function salvarConfigClickUp(
  _estado: EstadoClickUp,
  formData: FormData,
): Promise<EstadoClickUp> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const parsed = clickupConfigSchema.safeParse({
    teamId: String(formData.get("teamId") ?? "").trim(),
    defaultListId: String(formData.get("defaultListId") ?? "").trim(),
    spaceIdsPermitidos: String(formData.get("spaceIds") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    listasNomeadas: lerListasNomeadas(String(formData.get("listasNomeadas") ?? "")),
  });

  if (!parsed.success) {
    return {
      erro: "Confira os campos.",
      camposComErro: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join("."), i.message]),
      ),
    };
  }

  const enabled = formData.get("enabled") === "on";

  await db.integration.upsert({
    where: { provider: IntegrationProvider.CLICKUP },
    update: { config: parsed.data, enabled },
    create: {
      provider: IntegrationProvider.CLICKUP,
      label: "ClickUp",
      config: parsed.data,
      enabled,
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.clickup.updated",
      entity: "Integration",
      entityId: IntegrationProvider.CLICKUP,
    },
  });

  revalidatePath("/integracoes");
  return { ok: "Configuração salva." };
}

/** Token guardado cifrado. Só OWNER mexe em credencial. */
export async function salvarTokenClickUp(
  _estado: EstadoClickUp,
  formData: FormData,
): Promise<EstadoClickUp> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const token = String(formData.get("apiToken") ?? "").trim();
  if (token.length < 10) {
    return {
      erro: "Confira os campos.",
      camposComErro: { apiToken: "Token muito curto" },
    };
  }

  const integracao = await db.integration.upsert({
    where: { provider: IntegrationProvider.CLICKUP },
    update: {},
    create: {
      provider: IntegrationProvider.CLICKUP,
      label: "ClickUp",
      config: {},
      enabled: false,
    },
  });

  const cifrado = cifrar(token);
  await db.integrationCredential.upsert({
    where: { integrationId: integracao.id },
    update: { ...cifrado, rotatedAt: new Date() },
    create: { integrationId: integracao.id, ...cifrado },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.clickup.credential.rotated",
      entity: "Integration",
      entityId: IntegrationProvider.CLICKUP,
    },
  });

  revalidatePath("/integracoes");
  return { ok: "Token salvo. Use o botão de testar para confirmar." };
}

export async function testarConexaoClickUp(): Promise<EstadoClickUp> {
  await exigirPapel(UserRole.ADMIN);

  const atual = await registro();
  if (!atual?.credential) {
    return { erro: "Salve o token antes de testar." };
  }

  const config = clickupConfigSchema.safeParse(atual.config);
  if (!config.success) {
    return { erro: "Informe o id do workspace antes de testar." };
  }

  const cliente = new ClickUpClient(decifrar(atual.credential));
  const resultado = await cliente.testar();

  await db.integration.update({
    where: { provider: IntegrationProvider.CLICKUP },
    data: {
      status: resultado.ok ? IntegrationStatus.OK : IntegrationStatus.ERROR,
      lastCheckedAt: new Date(),
      lastError: resultado.ok ? null : resultado.mensagem,
    },
  });

  revalidatePath("/integracoes");
  return resultado.ok ? { ok: resultado.mensagem } : { erro: resultado.mensagem };
}

/**
 * Lista os workspaces do token para o operador descobrir o id sem sair do
 * painel — é o dado menos óbvio de achar na interface do ClickUp.
 */
export async function descobrirWorkspaces(): Promise<
  EstadoClickUp & { workspaces?: Array<{ id: string; nome: string }> }
> {
  await exigirPapel(UserRole.ADMIN);

  const atual = await registro();
  if (!atual?.credential) return { erro: "Salve o token primeiro." };

  try {
    const cliente = new ClickUpClient(decifrar(atual.credential));
    const { teams } = await cliente.listarWorkspaces();
    return {
      ok: `${teams.length} workspace(s) encontrado(s).`,
      workspaces: teams.map((t) => ({ id: t.id, nome: t.name })),
    };
  } catch (erro) {
    return {
      erro: erro instanceof Error ? erro.message : "Falha ao consultar.",
    };
  }
}
