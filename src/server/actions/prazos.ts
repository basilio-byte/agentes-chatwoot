"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";

export type EstadoPrazos = { ok?: string; erro?: string };

const PROVIDER = IntegrationProvider.PRAZOS;
const ROTULO = "Prazos da conversa";

/**
 * Só o liga/desliga: não há conta, chave nem endpoint para configurar. É também
 * o botão de parada — desligada, nenhum prazo pendente age (ver
 * `prazos/executar.ts`).
 */
export async function salvarConfigPrazos(
  _estado: EstadoPrazos,
  formData: FormData,
): Promise<EstadoPrazos> {
  const sessao = await exigirPapel(UserRole.ADMIN);
  const ligada = formData.get("enabled") === "on";

  await db.integration.upsert({
    where: { provider: PROVIDER },
    update: { enabled: ligada },
    create: { provider: PROVIDER, label: ROTULO, config: {}, enabled: ligada },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.prazos.updated",
      entity: "Integration",
      entityId: PROVIDER,
    },
  });

  revalidatePath("/integracoes");
  return {
    ok: ligada
      ? "Ligada. Falta liberar as ferramentas na tela de cada agente."
      : "Desligada. Nenhum agente registra prazo, e os pendentes não agem mais.",
  };
}
