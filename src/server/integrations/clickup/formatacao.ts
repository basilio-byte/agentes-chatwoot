import { diaEmSaoPaulo, inicioDoDiaEmSaoPaulo, somarDias } from "@/lib/tempo";
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

const HORA = 3_600_000;
const SO_DIA = /^\d{4}-\d{2}-\d{2}$/;
const DIA_E_HORA_SEM_FUSO = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** `somarDias` normaliza 2026-02-30 para 2026-03-02: se não volta igual, não existe. */
const diaExiste = (dia: string) => somarDias(dia, 0) === dia;

/**
 * ISO (`2026-08-05` ou com hora) para milissegundos, que é o que a API usa.
 *
 * ⚠ **Data sem hora é MEIO-DIA em São Paulo, nunca meia-noite UTC.** O ClickUp
 * guarda um instante e mostra o dia no fuso de quem olha. `Date.parse` de
 * `2026-09-15` é meia-noite UTC — 21h do dia 14 aqui —, e foi 14/09 que o
 * ClickUp gravou nas tasks do CRM Comercial em 15/09/2026, no vencimento e no
 * campo "Previsão de fechamento". Meio-dia fica no mesmo dia de UTC-12 a UTC+11.
 *
 * Hora sem fuso é hora de São Paulo: o container roda em UTC, e `Date.parse` a
 * leria como UTC. Com `Z` ou deslocamento, vale o que veio.
 */
export function paraTimestamp(iso?: string | null): number | undefined {
  const v = iso?.trim();
  if (!v) return undefined;

  if (SO_DIA.test(v)) {
    return diaExiste(v) ? inicioDoDiaEmSaoPaulo(v).getTime() + 12 * HORA : undefined;
  }

  const semFuso = v.match(DIA_E_HORA_SEM_FUSO);
  if (semFuso) {
    const [, dia, hh, mm, ss] = semFuso;
    if (!diaExiste(dia) || Number(hh) > 23 || Number(mm) > 59) return undefined;
    return (
      inicioDoDiaEmSaoPaulo(dia).getTime() +
      Number(hh) * HORA +
      Number(mm) * 60_000 +
      Number(ss ?? 0) * 1000
    );
  }

  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * "Até o dia X" para filtro de "menor que": o primeiro instante do dia SEGUINTE
 * em São Paulo. Meio-dia cortaria a tarefa que vence às 18h do próprio dia.
 */
export function paraTimestampDoFimDoDia(iso?: string | null): number | undefined {
  const v = iso?.trim();
  if (v && SO_DIA.test(v)) {
    return diaExiste(v) ? inicioDoDiaEmSaoPaulo(somarDias(v, 1)).getTime() : undefined;
  }
  return paraTimestamp(v);
}

/** Milissegundos da API para o dia no relógio de São Paulo — o dia que a equipe vê. */
export function deTimestamp(valor?: string | null): string | null {
  if (!valor) return null;
  const ms = Number(valor);
  if (!Number.isFinite(ms)) return null;
  return diaEmSaoPaulo(new Date(ms));
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
