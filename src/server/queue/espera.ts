/**
 * Quanto tempo o cliente pode ficar esperando antes de a conversa virar
 * problema de gente.
 *
 * Puro para ser testável sem banco nem relógio real: é a regra que decide
 * quando o sistema admite que não vai dar conta, e errar para mais deixa
 * cliente no vácuo, errar para menos tira o atendimento do agente no meio de um
 * turno legítimo.
 */

/** Padrão quando o agente não define o dele. */
export const MINUTOS_PADRAO = 3;

/**
 * Piso de segurança. Um turno legítimo encadeia transferências e usos de tool,
 * e já se viu 4 minutos num caso real de recuperação de erro — mas isso é
 * exceção, e o cliente esperando é a regra que importa. Menos de um minuto
 * arrancaria a conversa do agente antes de ele terminar de pensar.
 */
export const MINUTOS_MINIMO = 1;

export function minutosDeEspera(configurado?: number | null): number {
  if (configurado == null) return MINUTOS_PADRAO;
  return Math.max(MINUTOS_MINIMO, configurado);
}

export type ConversaEmEspera = {
  aguardandoDesde?: Date | null;
  /** Só conversa que o bot deveria estar tocando entra na conta. */
  status: string;
};

/**
 * Passou do tempo?
 *
 * `aguardandoDesde` nulo significa que ninguém está esperando — ou o agente já
 * respondeu, ou a conversa nunca teve pergunta pendente.
 */
export function esperouDemais(
  conversa: ConversaEmEspera,
  minutos: number,
  agora: number,
): boolean {
  if (conversa.status !== "BOT") return false;
  if (!conversa.aguardandoDesde) return false;

  return agora - conversa.aguardandoDesde.getTime() >= minutos * 60_000;
}
