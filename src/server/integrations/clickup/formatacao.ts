import type { ClickUpTarefa, ClickUpUsuario } from "./tipos";
import { nomeDaPrioridade } from "./tipos";

/** Tira acento e caixa, para casar "joao" com "João". */
export function normalizar(texto: string) {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // marcas de acento separadas pelo NFD
    .toLowerCase()
    .trim();
}

export type ResultadoMembro =
  | { tipo: "achado"; usuario: ClickUpUsuario }
  | { tipo: "ambiguo"; candidatos: ClickUpUsuario[] }
  | { tipo: "nenhum" };

/**
 * Resolve "a Ana" ou "ana@seahub.com" para o id numérico que a API exige.
 *
 * Devolve ambiguidade em vez de escolher sozinho: atribuir a tarefa à pessoa
 * errada é pior do que pedir para o agente confirmar qual delas.
 */
export function resolverMembro(
  termo: string,
  membros: ClickUpUsuario[],
): ResultadoMembro {
  const alvo = normalizar(termo);
  if (!alvo) return { tipo: "nenhum" };

  const exatos = membros.filter(
    (m) =>
      normalizar(m.email ?? "") === alvo || normalizar(m.username ?? "") === alvo,
  );
  if (exatos.length === 1) return { tipo: "achado", usuario: exatos[0] };
  if (exatos.length > 1) return { tipo: "ambiguo", candidatos: exatos };

  const parciais = membros.filter(
    (m) =>
      normalizar(m.username ?? "").includes(alvo) ||
      normalizar(m.email ?? "").includes(alvo),
  );
  if (parciais.length === 1) return { tipo: "achado", usuario: parciais[0] };
  if (parciais.length > 1) return { tipo: "ambiguo", candidatos: parciais };

  return { tipo: "nenhum" };
}

/**
 * Filtro por texto feito aqui porque a API do ClickUp não tem busca textual —
 * só filtros estruturados.
 */
export function filtrarPorTexto(tarefas: ClickUpTarefa[], termo?: string) {
  if (!termo?.trim()) return tarefas;
  const alvo = normalizar(termo);
  return tarefas.filter(
    (t) =>
      normalizar(t.name).includes(alvo) ||
      normalizar(t.description ?? "").includes(alvo),
  );
}

/** ISO (`2026-08-05` ou com hora) para milissegundos, que é o que a API usa. */
export function paraTimestamp(iso?: string | null): number | undefined {
  if (!iso?.trim()) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

export function deTimestamp(valor?: string | null): string | null {
  if (!valor) return null;
  const ms = Number(valor);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Resumo de uma tarefa para o modelo ler.
 *
 * Texto compacto em vez do JSON cru da API: o objeto do ClickUp tem dezenas de
 * campos irrelevantes que só gastariam token em toda mensagem.
 */
export function formatarTarefa(t: ClickUpTarefa) {
  return {
    id: t.id,
    nome: t.name,
    status: t.status?.status ?? null,
    // O id numérico é mais estável que o rótulo em inglês; o nome é o reserva.
    prioridade: nomeDaPrioridade(t.priority?.id ?? t.priority?.priority),
    vencimento: deTimestamp(t.due_date),
    responsaveis: (t.assignees ?? []).map((a) => a.username ?? a.email ?? String(a.id)),
    lista: t.list?.name ?? null,
    url: t.url ?? null,
  };
}

export function formatarTarefaDetalhada(t: ClickUpTarefa) {
  return {
    ...formatarTarefa(t),
    descricao: t.description ?? t.text_content ?? null,
    tags: (t.tags ?? []).map((tag) => tag.name),
    espaco: t.space?.name ?? null,
    pasta: t.folder?.name ?? null,
    criadaEm: deTimestamp(t.date_created),
    atualizadaEm: deTimestamp(t.date_updated),
  };
}
