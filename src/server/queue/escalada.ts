import { humanidadeDoDono, podeAgir } from "@/server/integrations/chatwoot/regras";

/**
 * O vigia pode escalar esta conversa agora?
 *
 * ⚠ Decidido contra o estado AO VIVO do Chatwoot (14/09/2026). Antes o vigia
 * confiava só no banco: conversa `BOT` com cliente esperando ganhava "Desculpe a
 * demora" e troca de dono. Se uma pessoa já tinha assumido e o webhook de conta
 * não chegou, ele falava por cima dela e tirava a conversa de quem estava
 * atendendo — a intromissão que o sistema existe para não cometer.
 *
 * Mesma regra de toda resposta do bot (`podeAgir`): dono de tipo desconhecido
 * conta como pessoa.
 */
export type VereditoDaEscalada =
  | { escalar: true }
  | { escalar: false; motivo: string; resolvida: boolean; donoHumano: boolean };

export function vereditoDaEscalada(aoVivo: {
  status: string | null;
  assigneeId: number | null;
  assigneeTipo: string | null;
}): VereditoDaEscalada {
  const donoEhHumano = humanidadeDoDono(aoVivo.assigneeTipo);
  const veredito = podeAgir({
    status: aoVivo.status,
    assigneeId: aoVivo.assigneeId,
    donoEhHumano,
  });
  if (veredito.pode) return { escalar: true };

  return {
    escalar: false,
    motivo: veredito.motivo,
    resolvida: veredito.resolvida === true,
    donoHumano: aoVivo.assigneeId != null && donoEhHumano !== false,
  };
}
