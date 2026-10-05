"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { configDoFormulario, lerConfigNotasFiscais } from "@/server/notas-fiscais/config";
import { reclassificar } from "@/server/notas-fiscais/conferir";

export type EstadoNotasFiscais = { ok?: string; erro?: string };

/**
 * Config e liga/desliga das notas fiscais, gravados juntos. Não toca em
 * `lastCheckedAt`/`status`/`lastError`: aquilo é o estado que o vigia escreve.
 *
 * Salvar também refaz a decisão das cobranças já vistas em modo sombra, com a
 * tabela nova — quem acabou de dar código a uma categoria quer ver as
 * cobranças dela saírem de "aguardando" na hora, e não na próxima rodada.
 */
export async function salvarConfigNotasFiscais(
  _estado: EstadoNotasFiscais,
  formData: FormData,
): Promise<EstadoNotasFiscais> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const atual = await db.integration.findUnique({
    where: { provider: IntegrationProvider.NOTAS_FISCAIS },
    select: { config: true },
  });
  const campos: Record<string, string> = {};
  for (const [campo, valor] of formData.entries()) {
    if (typeof valor === "string") campos[campo] = valor;
  }
  const lido = configDoFormulario(campos, lerConfigNotasFiscais(atual?.config));
  if ("erro" in lido) return { erro: lido.erro };

  const ligada = formData.get("enabled") === "on";
  const config = lido.config as unknown as Prisma.InputJsonValue;

  await db.integration.upsert({
    where: { provider: IntegrationProvider.NOTAS_FISCAIS },
    update: { enabled: ligada, config },
    create: {
      provider: IntegrationProvider.NOTAS_FISCAIS,
      label: "Notas fiscais (Spedy)",
      config,
      enabled: ligada,
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.notas_fiscais.updated",
      entity: "Integration",
      entityId: IntegrationProvider.NOTAS_FISCAIS,
      diff: {
        enabled: ligada,
        modo: lido.config.modo,
        inicio: lido.config.inicio,
        codigos: lido.config.codigos,
        codigoReservaDeSala: lido.config.codigoReservaDeSala,
        regrasPorCliente: lido.config.clientes.length,
      },
    },
  });

  const refeitas = await reclassificar(lido.config);
  revalidatePath("/integracoes");

  const mudou = refeitas.mudadas + refeitas.apagadas;
  const efeito = mudou
    ? ` ${refeitas.mudadas} cobrança(s) já vista(s) refeita(s) com a tabela nova${refeitas.apagadas ? `, e ${refeitas.apagadas} volta(m) a ser lida(s) na próxima conferência` : ""}.`
    : "";
  return {
    ok:
      (ligada
        ? "Modo sombra ligado. A primeira conferência acontece em até 1 minuto e depois a cada 30 minutos. Nenhuma nota é emitida."
        : "Desligado. Nada é lido do Conexa.") + efeito,
  };
}
