"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigirPapel } from "@/server/auth-guard";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";
import { lerDestinatarios } from "@/server/alerta-de-saldo/regras";
import { configAvisosSchema } from "@/server/avisos/regras";

export type EstadoAvisos = { ok?: string; erro?: string };

const PROVIDER = IntegrationProvider.AVISOS;
const ROTULO = "Aviso à equipe (WhatsApp)";

const lista = (formData: FormData, campo: string) =>
  formData.getAll(campo).map((v) => (typeof v === "string" ? v : ""));

/**
 * Configuração do aviso à equipe. Administrador para cima: os telefones são de
 * pessoas da equipe, como no alerta de saldo e no presente de aniversário.
 */
export async function salvarConfigAvisos(
  _estado: EstadoAvisos,
  formData: FormData,
): Promise<EstadoAvisos> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const lidos = lerDestinatarios(lista(formData, "nome"), lista(formData, "telefone"));
  if ("erro" in lidos) return { erro: lidos.erro };

  const ligada = formData.get("enabled") === "on";
  // Ligada sem ninguém: o agente chamaria a ferramenta e não haveria a quem avisar.
  if (ligada && lidos.destinatarios.length === 0) {
    return { erro: "Cadastre pelo menos uma pessoa antes de ligar." };
  }

  const caixaBruta = Number(String(formData.get("caixaId") ?? "").trim());
  const lido = configAvisosSchema.safeParse({
    destinatarios: lidos.destinatarios,
    caixaId: Number.isInteger(caixaBruta) ? caixaBruta : NaN,
  });
  if (!lido.success) return { erro: "A caixa é o número dela no Chatwoot, como 31." };

  const config = JSON.parse(JSON.stringify(lido.data));
  await db.integration.upsert({
    where: { provider: PROVIDER },
    update: { enabled: ligada, config },
    create: { provider: PROVIDER, label: ROTULO, config, enabled: ligada },
  });

  // Sem telefone no rastro: a auditoria é lida por quem não vê os números.
  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "integration.avisos.updated",
      entity: "Integration",
      entityId: PROVIDER,
      diff: {
        ligada,
        destinatarios: lido.data.destinatarios.map((d) => d.nome),
        caixaId: lido.data.caixaId,
      },
    },
  });

  revalidatePath("/integracoes");
  return {
    ok: ligada
      ? "Ligada. Falta ligar a integração na tela de cada agente que pode mandar aviso."
      : "Desligada. Nenhum agente manda aviso por aqui.",
  };
}
