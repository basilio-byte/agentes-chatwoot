import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { MODOS_DE_CAIXA } from "@/server/agents/equipe";
import { auditar, type Autor, type Desfecho } from "./autor";

/**
 * Onde o agente atua e para quem ele escala: caixas de entrada, conta do
 * Chatwoot e o responsável padrão.
 *
 * A conta é do BOT (é o token dele que fala com aquela conta), mas a lista de
 * caixas fica no agente, porque vale também para o roteamento e para o roster —
 * um colega que não atua na caixa não deve nem aparecer para transferência.
 */
export type EscopoDoAgente = {
  /** `all` ou `specific`. Texto cru: quem recusa valor fora da lista é aqui. */
  inboxMode: string;
  inboxIds: number[];
  /** Nulo = herda a conta de Integrações. */
  accountId: number | null;
  /** Nulo = padrão do sistema. */
  fallbackMinutos: number | null;
  /** Nulo = devolve à fila humana sem escolher pessoa. */
  fallbackAtendente: string | null;
};

export async function salvarEscopo(
  agentId: string,
  escopo: EscopoDoAgente,
  autor: Autor,
): Promise<Desfecho> {
  const modo = escopo.inboxMode;
  if (!MODOS_DE_CAIXA.includes(modo as (typeof MODOS_DE_CAIXA)[number])) {
    return { erro: "Modo de caixa inválido." };
  }

  const ids = [
    ...new Set(escopo.inboxIds.filter((n) => Number.isInteger(n) && n > 0)),
  ].sort((a, b) => a - b);
  if (modo === "specific" && ids.length === 0) {
    return {
      erro: 'Informe pelo menos um id de caixa, ou deixe em "todas as caixas".',
    };
  }

  const { accountId, fallbackMinutos: minutos } = escopo;
  if (accountId !== null && (!Number.isInteger(accountId) || accountId <= 0)) {
    return { erro: "O id da conta precisa ser um número positivo." };
  }
  if (minutos !== null && (!Number.isInteger(minutos) || minutos < 1)) {
    return { erro: "Os minutos de espera precisam ser um número a partir de 1." };
  }

  const agente = await db.agent.findUnique({
    where: { id: agentId },
    select: { id: true },
  });
  if (!agente) return { erro: "Agente não encontrado." };

  const inboxIds = modo === "specific" ? ids : [];
  const fallbackAtendente = escopo.fallbackAtendente?.trim() || null;

  await db.agent.update({
    where: { id: agentId },
    data: { inboxMode: modo, inboxIds, fallbackMinutos: minutos, fallbackAtendente },
  });

  // Só mexe na conta se o bot já existe — sem bot não há token a que associá-la.
  const bot = await db.agentChatwootBot.findUnique({ where: { agentId } });
  if (bot) {
    await db.agentChatwootBot.update({
      where: { agentId },
      data: { accountId },
    });
  }

  await auditar(autor, "agent.scope.updated", "Agent", agentId, {
    inboxMode: modo,
    inboxIds,
    accountId: bot ? accountId : null,
    fallbackMinutos: minutos,
    fallbackAtendente,
  });

  revalidatePath(`/agentes/${agentId}`);

  if (accountId && !bot) {
    return {
      ok: "Escopo salvo. A conta só vale depois de cadastrar o bot deste agente.",
    };
  }
  return {
    ok:
      modo === "all"
        ? "Agente atuando em todas as caixas."
        : `Agente restrito à(s) caixa(s) ${ids.join(", ")}.`,
  };
}
