"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { configDoFormulario } from "@/server/followup-reserva/config";

export type EstadoFollowup = { ok?: string; erro?: string };

/**
 * Config e liga/desliga do follow-up de reserva, gravados juntos. Ligar em
 * `ligado` fala com CLIENTE: fica na auditoria quem ligou e em que modo.
 */
export async function salvarConfigFollowup(
  _estado: EstadoFollowup,
  formData: FormData,
): Promise<EstadoFollowup> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const lido = configDoFormulario((campo) => {
    const valor = formData.get(campo);
    return typeof valor === "string" ? valor : null;
  });
  if ("erro" in lido) return { erro: lido.erro };

  const ligada = formData.get("enabled") === "on";
  const config = lido.config as unknown as Prisma.InputJsonValue;

  await db.integration.upsert({
    where: { provider: IntegrationProvider.FOLLOWUP_RESERVA },
    update: { enabled: ligada, config },
    create: {
      provider: IntegrationProvider.FOLLOWUP_RESERVA,
      label: "Follow-up de reserva",
      config,
      enabled: ligada,
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.followup_reserva.updated",
      entity: "Integration",
      entityId: IntegrationProvider.FOLLOWUP_RESERVA,
      diff: { enabled: ligada, modo: lido.config.modo },
    },
  });

  revalidatePath("/integracoes");
  if (!ligada) return { ok: "Desligado. Nenhuma reserva é conferida, e nada sai." };
  return {
    ok:
      lido.config.modo === "ligado"
        ? "Ligado. A reserva do agente que não aparecer paga recebe a mensagem perto do horário."
        : "Ligado em modo sombra: a rodada confere e registra o que faria, sem mandar nada a ninguém.",
  };
}
