"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { configDoFormulario, lerConfigCobranca } from "@/server/cobranca/regras";

export type EstadoCobranca = { ok?: string; erro?: string };

/**
 * Config e liga/desliga do aviso de cobrança, gravados juntos. Não toca em
 * `lastCheckedAt`/`status`/`lastError`: aquilo é o estado que o vigia escreve.
 */
export async function salvarConfigCobranca(
  _estado: EstadoCobranca,
  formData: FormData,
): Promise<EstadoCobranca> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const atual = await db.integration.findUnique({
    where: { provider: IntegrationProvider.COBRANCA },
    select: { config: true },
  });
  const lido = configDoFormulario((campo) => {
    const valor = formData.get(campo);
    return typeof valor === "string" ? valor : null;
  }, lerConfigCobranca(atual?.config));
  if ("erro" in lido) return { erro: lido.erro };

  const ligada = formData.get("enabled") === "on";
  const config = lido.config as unknown as Prisma.InputJsonValue;

  await db.integration.upsert({
    where: { provider: IntegrationProvider.COBRANCA },
    update: { enabled: ligada, config },
    create: {
      provider: IntegrationProvider.COBRANCA,
      label: "Aviso de cobrança (ClickUp)",
      config,
      enabled: ligada,
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.cobranca.updated",
      entity: "Integration",
      entityId: IntegrationProvider.COBRANCA,
      diff: {
        enabled: ligada,
        caixaId: lido.config.caixaId,
        aposEnviar: lido.config.aposEnviar,
        atribuirA: lido.config.atribuirA,
      },
    },
  });

  revalidatePath("/integracoes");
  return {
    ok: ligada
      ? "Ligada. A primeira conferência acontece em até 1 minuto (em horário comercial) e depois a cada 30 minutos."
      : "Desligada. Nenhuma mensagem de cobrança sai, e as etiquetas ficam nas tasks.",
  };
}
