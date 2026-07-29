/**
 * Regras globais de quando um agente pode agir numa conversa.
 *
 * Definidas em um lugar só, como funções puras, porque são a diferença entre o
 * bot ajudar e o bot atropelar um atendimento humano. São aplicadas em três
 * pontos: na chegada do webhook, no início do processamento e — o que torna a
 * regra absoluta — imediatamente antes de enviar a resposta, contra o estado ao
 * vivo do Chatwoot.
 */

/** Status em que o agente pode falar. Qualquer outro é silêncio. */
export const STATUS_PERMITIDOS = ["open", "pending"] as const;

export type EstadoDaConversa = {
  status?: string | null;
  /** Id do agente humano responsável, se houver. */
  assigneeId?: number | null;
};

export type Veredito =
  | { pode: true }
  | { pode: false; motivo: string; resolvida?: boolean };

export function podeAgir(estado: EstadoDaConversa): Veredito {
  // Regra 1: humano assumiu, o bot cala. Vale mesmo em conversa aberta.
  if (estado.assigneeId != null) {
    return { pode: false, motivo: "conversa atribuída a um humano" };
  }

  const status = estado.status?.toLowerCase();

  // Regra 2: conversa resolvida não recebe interação nenhuma.
  if (status === "resolved") {
    return { pode: false, motivo: "conversa resolvida", resolvida: true };
  }

  if (status && !STATUS_PERMITIDOS.includes(status as "open" | "pending")) {
    return { pode: false, motivo: `conversa em status ${status}` };
  }

  return { pode: true };
}

export function ehResolvida(status?: string | null) {
  return status?.toLowerCase() === "resolved";
}
