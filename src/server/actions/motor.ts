"use server";

import { revalidatePath } from "next/cache";
import { exigirPapel } from "@/server/auth-guard";
import { UserRole } from "@/generated/prisma/enums";
import { autorDaSessao } from "@/server/gestao/autor";
import { definirMotorDoAgente, salvarMotorGlobal } from "@/server/gestao/motor";

export type EstadoDoMotor = { ok?: string; erro?: string };

const texto = (formData: FormData, campo: string) => {
  const valor = formData.get(campo);
  return typeof valor === "string" ? valor : "";
};

/**
 * A chave geral OpenRouter ⇄ Claude MAX. Administrador para cima: é a mesma
 * decisão de trocar o modelo de um agente, só que de todos de uma vez.
 */
export async function salvarMotorGlobalAction(
  _estado: EstadoDoMotor,
  formData: FormData,
): Promise<EstadoDoMotor> {
  const sessao = await exigirPapel(UserRole.ADMIN);
  const desfecho = await salvarMotorGlobal(
    {
      claudeMaxLigado: formData.get("claudeMaxLigado") === "on",
      modeloPadrao: texto(formData, "modeloPadrao"),
    },
    autorDaSessao(sessao),
  );
  revalidatePath("/agentes");
  return "erro" in desfecho ? { erro: desfecho.erro } : { ok: desfecho.ok };
}

export async function definirMotorDoAgenteAction(
  agentId: string,
  _estado: EstadoDoMotor,
  formData: FormData,
): Promise<EstadoDoMotor> {
  const sessao = await exigirPapel(UserRole.ADMIN);
  const desfecho = await definirMotorDoAgente(
    agentId,
    { motor: texto(formData, "motor"), modeloClaudeMax: texto(formData, "modeloClaudeMax") },
    autorDaSessao(sessao),
  );
  revalidatePath(`/agentes/${agentId}`);
  revalidatePath("/agentes");
  return "erro" in desfecho ? { erro: desfecho.erro } : { ok: desfecho.ok };
}
