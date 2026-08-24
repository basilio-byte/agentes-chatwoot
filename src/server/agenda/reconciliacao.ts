/**
 * O que precisa mudar no Redis para ele refletir o Postgres.
 *
 * Puro para ser testável: a decisão de criar e remover agendadores é fácil de
 * errar para os dois lados, e os dois erros são caros. Remover a mais apaga um
 * agendamento que alguém configurou; criar a menos deixa um agendamento ligado
 * na tela que nunca dispara — e ninguém percebe, porque "não aconteceu nada" é
 * indistinguível de "ainda não deu a hora".
 */

export type Reconciliacao = {
  /** Agendadores a inserir ou atualizar no Redis. */
  paraSincronizar: string[];
  /** Agendadores no Redis que não existem mais no Postgres. */
  paraRemover: string[];
};

/**
 * @param desejados ids dos agendamentos que DEVEM estar rodando (ligados, de
 *                  agente ativo e não arquivado)
 * @param existentes ids dos agendadores que o Redis tem agora
 */
export function reconciliar(
  desejados: string[],
  existentes: string[],
): Reconciliacao {
  const noBanco = new Set(desejados);

  return {
    // Todos os desejados, inclusive os que já existem: o upsert é idempotente e
    // é ele que corrige uma expressão que mudou enquanto o worker estava fora.
    paraSincronizar: [...noBanco],
    paraRemover: existentes.filter((id) => !noBanco.has(id)),
  };
}
