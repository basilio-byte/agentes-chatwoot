/**
 * Desde quando cada tarefa está no status de agora.
 *
 * ⚠ **Corrige uma premissa antiga deste projeto**: "a API do ClickUp não expõe a
 * Atividade, então não dá para saber há quanto tempo a tarefa está no status".
 * A Atividade continua ilegível, mas o ClickApp **"Total time in Status"**, que
 * está ligado no workspace da Seahub (conferido em 16/11/2026), devolve o
 * instante em que a tarefa ENTROU no status atual — `GET
 * /task/bulk_time_in_status/task_ids`, até 100 por chamada. É o que a renovação
 * usa para contar os dois dias em `renovação` sem guardar relógio próprio.
 *
 * O formato cru tem `current_status.total_time.since` (milissegundos, em texto);
 * o conector de MCP simplifica para `current_status.since`. Lê os dois, porque
 * quem decide mover tarefa não pode depender de um formato só.
 */

export type EntradaNoStatus = {
  status: string | null;
  /** Milissegundos desde a época: quando a tarefa entrou no status de agora. */
  desde: number | null;
};

export function lerTempoNoStatus(bruto: unknown): Record<string, EntradaNoStatus> {
  const saida: Record<string, EntradaNoStatus> = {};
  if (!bruto || typeof bruto !== "object") return saida;

  // A resposta é um mapa `id → dados`; alguns formatos embrulham em `tasks`.
  const mapa = (
    "tasks" in bruto && bruto.tasks && typeof bruto.tasks === "object" ? bruto.tasks : bruto
  ) as Record<string, unknown>;

  for (const [id, dados] of Object.entries(mapa)) {
    const atual = (dados as { current_status?: Record<string, unknown> } | null)?.current_status;
    if (!atual || typeof atual !== "object") continue;

    const total = atual.total_time;
    const since =
      total && typeof total === "object"
        ? (total as { since?: unknown }).since
        : atual.since;
    const ms = Number(since);

    saida[id] = {
      status: typeof atual.status === "string" ? atual.status : null,
      desde: Number.isFinite(ms) && ms > 0 ? ms : null,
    };
  }
  return saida;
}
