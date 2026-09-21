"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { configDoFormulario } from "@/server/janela/config";

export type EstadoJanela = { ok?: string; erro?: string };

/**
 * Config e liga/desliga da janela de 24 h, gravados juntos. Não toca em
 * `lastCheckedAt`/`status`/`lastError`: aquilo é o estado que o vigia escreve,
 * e o formulário não escreve estado.
 */
export async function salvarConfigJanela(
  _estado: EstadoJanela,
  formData: FormData,
): Promise<EstadoJanela> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const lido = configDoFormulario((campo) => {
    const valor = formData.get(campo);
    return typeof valor === "string" ? valor : null;
  });
  if ("erro" in lido) return { erro: lido.erro };

  const ligada = formData.get("enabled") === "on";
  const config = lido.config as unknown as Prisma.InputJsonValue;

  await db.integration.upsert({
    where: { provider: IntegrationProvider.JANELA },
    update: { enabled: ligada, config },
    create: {
      provider: IntegrationProvider.JANELA,
      label: "Janela de 24 h do WhatsApp",
      config,
      enabled: ligada,
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.janela.updated",
      entity: "Integration",
      entityId: IntegrationProvider.JANELA,
      diff: { enabled: ligada, caixas: lido.config.caixas, minutosDeAviso: lido.config.minutosDeAviso },
    },
  });

  revalidatePath("/integracoes");
  return {
    ok: ligada
      ? "Ligada. A primeira conferência acontece em até 5 minutos; as conversas já vencidas são corrigidas aos poucos, 40 por conferência."
      : "Desligada. Nenhuma nota nova sai e nenhuma etiqueta é trocada.",
  };
}
