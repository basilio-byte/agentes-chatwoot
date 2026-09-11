import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { auditar, type Autor, type Desfecho } from "./autor";

/**
 * Liga/desliga o gatilho HTTP sem tocar no segredo.
 *
 * Ligar limpa o auto-desligamento anterior: religar depois de um estouro de
 * teto é decisão humana e consciente, mesma filosofia de "restaurar devolve
 * desligado" do arquivamento de agente.
 *
 * Gerar o token não está aqui de propósito: é poder de OWNER, e o MCP não o
 * oferece a ninguém.
 */
export async function definirGatilho(
  agentId: string,
  ligar: boolean,
  autor: Autor,
): Promise<Desfecho> {
  const trigger = await db.agentTrigger.findUnique({ where: { agentId } });
  if (!trigger) {
    return {
      erro: "Este agente ainda não tem gatilho HTTP. O token precisa ser gerado antes — e só o Proprietário gera, pelo painel.",
    };
  }

  await db.agentTrigger.update({
    where: { agentId },
    data: {
      enabled: ligar,
      ...(ligar
        ? { pausadoAutomaticamenteEm: null, pausadoAutomaticamenteMotivo: null }
        : {}),
    },
  });

  await auditar(
    autor,
    ligar ? "agent.trigger.enabled" : "agent.trigger.disabled",
    "Agent",
    agentId,
  );

  revalidatePath(`/agentes/${agentId}`);
  return { ok: ligar ? "Gatilho HTTP ligado." : "Gatilho HTTP desligado." };
}
