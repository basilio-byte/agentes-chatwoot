"use server";

import { revalidatePath } from "next/cache";

import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { lerDocumentos } from "@/server/acompanhamento/documentos";

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
  const documentos = String(formData.get("documentos") ?? "").slice(0, 20_000);

  // ⚠ O campo vai para o WhatsApp de um cliente: recusa ANTES de gravar, em
  // vez de descartar em silêncio na hora de mandar. Quem digitou precisa saber.
  const lidos = lerDocumentos(documentos);
  const linhasComLink = documentos
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\[.+\]$/.test(l));
  const aceitas = Object.values(lidos).reduce((n, d) => n + d.length, 0);
  if (linhasComLink.length > aceitas) {
    return {
      erro: `${linhasComLink.length - aceitas} linha(s) não foram entendidas. Cada documento é "Nome: https://endereço", e cada prédio começa com uma linha "[Nome do produto]".`,
    };
  }

  await db.integration.upsert({
    where: { provider: IntegrationProvider.ACOMPANHAMENTO },
    update: { enabled: ligada, config: { documentos } },
    create: {
      provider: IntegrationProvider.ACOMPANHAMENTO,
      label: "Acompanhamento de contratos",
      config: { documentos },
      enabled: ligada,
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.acompanhamento.updated",
      entity: "Integration",
      entityId: IntegrationProvider.ACOMPANHAMENTO,
      // Os endereços não entram na auditoria: o que importa é quem mexeu.
      diff: { enabled: ligada, documentos: aceitas },
    },
  });

  revalidatePath("/integracoes");
  const quantos = aceitas ? ` ${aceitas} documento(s) configurado(s).` : "";
  return {
    ok: ligada
      ? `Ligado. A primeira conferência acontece em até 10 minutos, e o cliente passa a receber os links assim que o contrato for gerado.${quantos}`
      : `Desligado. Nenhuma mensagem sai, e as etiquetas ficam nas tasks.${quantos}`,
  };
}
