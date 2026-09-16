"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { configDoFormulario } from "@/server/nps/config";

export type EstadoNps = { ok?: string; erro?: string };

/**
 * Config e liga/desliga da pesquisa de satisfação, gravados juntos, como nas
 * outras integrações. Desligar é o botão de parada: nenhuma pesquisa nova sai, e
 * as em andamento não agem mais (`nps/executar.ts`).
 */
export async function salvarConfigNps(
  _estado: EstadoNps,
  formData: FormData,
): Promise<EstadoNps> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const lido = configDoFormulario((campo) => {
    const valor = formData.get(campo);
    return typeof valor === "string" ? valor : null;
  });
  if ("erro" in lido) return { erro: lido.erro };

  const ligada = formData.get("enabled") === "on";
  const config = lido.config as unknown as Prisma.InputJsonValue;

  await db.integration.upsert({
    where: { provider: IntegrationProvider.NPS },
    update: { enabled: ligada, config },
    create: {
      provider: IntegrationProvider.NPS,
      label: "Pesquisa de satisfação (NPS)",
      config,
      enabled: ligada,
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.nps.updated",
      entity: "Integration",
      entityId: IntegrationProvider.NPS,
      diff: { enabled: ligada },
    },
  });

  revalidatePath("/integracoes");
  return {
    ok: ligada
      ? "Ligada. Marcar o checkbox passa a mandar a pesquisa por aqui — com o NPS do n8n publicado, o cliente recebe em dobro."
      : "Desligada. Nenhuma pesquisa nova sai, e as em andamento não agem mais.",
  };
}
