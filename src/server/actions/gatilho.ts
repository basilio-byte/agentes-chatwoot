"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { cifrar } from "@/lib/crypto";
import { exigirPapel } from "@/server/auth-guard";
import { UserRole } from "@/generated/prisma/enums";
import { gerarToken } from "@/server/gatilho/token";

export type EstadoGatilho = {
  ok?: string;
  erro?: string;
};

export type ResumoGatilho = {
  configurado: boolean;
  enabled: boolean;
  hint: string | null;
  rotatedAt: Date | null;
  pausadoAutomaticamenteEm: Date | null;
  pausadoAutomaticamenteMotivo: string | null;
};

export async function resumoDoGatilho(agentId: string): Promise<ResumoGatilho> {
  const trigger = await db.agentTrigger.findUnique({ where: { agentId } });

  return {
    configurado: Boolean(trigger),
    enabled: trigger?.enabled ?? false,
    hint: trigger?.hint ?? null,
    rotatedAt: trigger?.rotatedAt ?? null,
    pausadoAutomaticamenteEm: trigger?.pausadoAutomaticamenteEm ?? null,
    pausadoAutomaticamenteMotivo: trigger?.pausadoAutomaticamenteMotivo ?? null,
  };
}

/**
 * Gera (ou rotaciona) o token do gatilho e devolve a URL **completa, em texto
 * puro** — a única vez que isso acontece. Diferente de toda outra credencial
 * do projeto: aqui o segredo nasce do nosso lado, e é a única forma de o
 * operador colá-lo na URL configurada no sistema externo.
 *
 * `enabled` nasce `false` na criação (mesma doutrina de Agent.active: só
 * entra em produção de propósito) e é PRESERVADO na rotação — rotacionar não
 * deve mudar o estado ligado/desligado em nenhuma direção.
 */
export async function gerarOuRotacionarToken(
  agentId: string,
): Promise<EstadoGatilho & { tokenPlano?: string }> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const agente = await db.agent.findUnique({
    where: { id: agentId },
    select: { id: true },
  });
  if (!agente) return { erro: "Agente não encontrado." };

  const token = gerarToken();
  const cifrado = cifrar(token);

  await db.agentTrigger.upsert({
    where: { agentId },
    update: {
      ciphertext: cifrado.ciphertext,
      iv: cifrado.iv,
      authTag: cifrado.authTag,
      hint: cifrado.hint,
      rotatedAt: new Date(),
    },
    create: {
      agentId,
      enabled: false,
      ciphertext: cifrado.ciphertext,
      iv: cifrado.iv,
      authTag: cifrado.authTag,
      hint: cifrado.hint,
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "agent.trigger.rotated",
      entity: "Agent",
      entityId: agentId,
    },
  });

  revalidatePath(`/agentes/${agentId}`);
  return {
    ok: "Token gerado. Copie a URL agora — ela não aparece de novo.",
    tokenPlano: token,
  };
}

/**
 * Liga/desliga o gatilho sem tocar no segredo — mesmo tier de permissão de
 * `alternarAtivo` do agente, e mesmo contrato de retorno (`void`): é chamada
 * direto como `<form action={alternarGatilho.bind(null, agentId, ligar)}>`,
 * sem `useActionState`, e o React exige que a action devolva `void`. Ligar
 * limpa o auto-desligamento anterior: religar depois de um estouro de teto é
 * decisão humana e consciente, mesma filosofia de "restaurar devolve
 * desligado" do arquivamento de agente.
 */
export async function alternarGatilho(agentId: string, ligar: boolean) {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const trigger = await db.agentTrigger.findUnique({ where: { agentId } });
  if (!trigger) return;

  await db.agentTrigger.update({
    where: { agentId },
    data: {
      enabled: ligar,
      ...(ligar
        ? { pausadoAutomaticamenteEm: null, pausadoAutomaticamenteMotivo: null }
        : {}),
    },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: ligar ? "agent.trigger.enabled" : "agent.trigger.disabled",
      entity: "Agent",
      entityId: agentId,
    },
  });

  revalidatePath(`/agentes/${agentId}`);
}
