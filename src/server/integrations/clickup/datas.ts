/**
 * A leitura de data do ClickUp, isolada.
 *
 * Mora aqui, e não em `formatacao.ts`, só para quebrar um ciclo de importação:
 * `formatacao` passou a depender de `campos-da-tarefa`, e `campos-da-tarefa`
 * precisa desta função. ESM aguenta o ciclo, mas um ciclo que "funciona"
 * quebra no dia em que alguém mover uma chamada para o topo do módulo.
 *
 * `formatacao.ts` continua reexportando `deTimestamp`: nenhum import existente
 * precisou mudar.
 */

import { diaEmSaoPaulo } from "@/lib/tempo";

/** Milissegundos da API para o dia no relógio de São Paulo — o dia que a equipe vê. */
export function deTimestamp(valor?: string | null): string | null {
  if (!valor) return null;
  const ms = Number(valor);
  if (!Number.isFinite(ms)) return null;
  return diaEmSaoPaulo(new Date(ms));
}
