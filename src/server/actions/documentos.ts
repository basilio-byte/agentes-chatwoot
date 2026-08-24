"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import {
  IntegrationProvider,
  IntegrationStatus,
  UserRole,
} from "@/generated/prisma/enums";
import { documentosIntegration } from "@/server/documentos";

export type EstadoDocumentos = { ok?: string; erro?: string };

const PROVIDER = IntegrationProvider.DOCUMENTOS;
const ROTULO = "Documentos (CPF, CNH, CNPJ)";

/**
 * Só o liga/desliga: esta integração não tem conta, chave nem endpoint privado
 * para configurar. O formulário existe porque o toggle global mora em
 * `Integration.enabled`, e sem tela ninguém consegue ligá-lo.
 */
export async function salvarConfigDocumentos(
  _estado: EstadoDocumentos,
  formData: FormData,
): Promise<EstadoDocumentos> {
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
      action: "integration.documentos.updated",
      entity: "Integration",
      entityId: PROVIDER,
    },
  });

  revalidatePath("/integracoes");
  return {
    ok: ligada
      ? "Ligada. Falta liberar as ferramentas na tela de cada agente."
      : "Desligada. Nenhum agente enxerga as ferramentas de documento.",
  };
}

export async function testarConexaoDocumentos(): Promise<EstadoDocumentos> {
  await exigirPapel(UserRole.ADMIN);

  const resultado = await documentosIntegration.testarConexao({
    provider: PROVIDER,
    config: {},
    credential: null,
    agentId: "",
  });

  await db.integration.update({
    where: { provider: PROVIDER },
    data: {
      // Indeterminado não é falha: a consulta de CNPJ é de terceiro e pode
      // estar fora do ar sem que a conferência de CPF e CNH pare — ela é
      // offline. Marcar erro mandaria procurar problema onde não há.
      status: resultado.ok
        ? IntegrationStatus.OK
        : resultado.indeterminado
          ? IntegrationStatus.NOT_CONFIGURED
          : IntegrationStatus.ERROR,
      lastCheckedAt: new Date(),
      lastError: resultado.ok ? null : resultado.mensagem,
    },
  });

  revalidatePath("/integracoes");
  return resultado.ok ? { ok: resultado.mensagem } : { erro: resultado.mensagem };
}
