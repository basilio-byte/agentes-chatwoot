"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { lerPrefixos } from "@/server/materiais/macros";

export type EstadoMateriais = { ok?: string; erro?: string };

const PROVIDER = IntegrationProvider.MATERIAIS;
const ROTULO = "Fotos e materiais prontos";

/**
 * Liga/desliga e os prefixos dos macros que viram material. Não há credencial:
 * a leitura usa o token de Integrações → Chatwoot, e o envio, o robô da conversa.
 */
export async function salvarConfigMateriais(
  _estado: EstadoMateriais,
  formData: FormData,
): Promise<EstadoMateriais> {
  const sessao = await exigirPapel(UserRole.ADMIN);
  const ligada = formData.get("enabled") === "on";
  const prefixos = lerPrefixos(String(formData.get("prefixos") ?? ""));

  if (prefixos.some((p) => p.length > 60)) {
    return { erro: "Um prefixo passou de 60 caracteres. Use o começo do nome do macro, como [SR]." };
  }

  await db.integration.upsert({
    where: { provider: PROVIDER },
    update: { enabled: ligada, config: { prefixos } },
    create: { provider: PROVIDER, label: ROTULO, config: { prefixos }, enabled: ligada },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.materiais.updated",
      entity: "Integration",
      entityId: PROVIDER,
      diff: { ligada, prefixos },
    },
  });

  revalidatePath("/integracoes");
  if (!prefixos.length) {
    return { ok: "Salvo sem prefixo nenhum: nenhum macro vira material, e nada é enviado." };
  }
  return {
    ok: ligada
      ? "Ligada. Falta ligar a integração na tela de cada agente que pode mandar as imagens."
      : "Desligada. Nenhum agente manda imagem de macro.",
  };
}
