"use server";

import { revalidatePath } from "next/cache";

import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";

export type EstadoAcompanhamento = { ok?: string; erro?: string };

/**
 * Liga e desliga o acompanhamento de contratos.
 *
 * ⚠ **Ligar faz o sistema MANDAR MENSAGEM A CLIENTE** dentro de uma conversa
 * que está com um vendedor — é a exceção consciente desta capacidade. Por isso
 * exige ADMIN e a auditoria guarda quem ligou: é o único registro de quem
 * autorizou o robô a falar por cima de alguém.
 */
export async function salvarConfigAcompanhamento(
  _estado: EstadoAcompanhamento,
  formData: FormData,
): Promise<EstadoAcompanhamento> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const ligada = formData.get("enabled") === "on";

  await db.integration.upsert({
    where: { provider: IntegrationProvider.ACOMPANHAMENTO },
    update: { enabled: ligada },
    create: {
      provider: IntegrationProvider.ACOMPANHAMENTO,
      label: "Acompanhamento de contratos",
      config: {},
      enabled: ligada,
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.acompanhamento.updated",
      entity: "Integration",
      entityId: IntegrationProvider.ACOMPANHAMENTO,
      diff: { enabled: ligada },
    },
  });

  revalidatePath("/integracoes");
  return {
    ok: ligada
      ? "Ligado. A primeira conferência acontece em até 10 minutos, e o cliente passa a receber os links assim que o contrato for gerado."
      : "Desligado. Nenhuma mensagem sai, e as etiquetas ficam nas tasks.",
  };
}
