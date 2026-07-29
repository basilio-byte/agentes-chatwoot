/**
 * Formas de resposta da API v2 do ClickUp que realmente usamos.
 *
 * Deliberadamente parciais: a API devolve muito mais campo do que precisamos, e
 * declarar só o que se usa evita quebrar quando eles adicionam coisa nova.
 */

export type ClickUpUsuario = {
  id: number;
  username?: string | null;
  email?: string | null;
  initials?: string | null;
};

export type ClickUpWorkspace = {
  id: string;
  name: string;
  members?: Array<{ user: ClickUpUsuario }>;
};

export type ClickUpSpace = {
  id: string;
  name: string;
  archived?: boolean;
};

export type ClickUpFolder = {
  id: string;
  name: string;
  archived?: boolean;
  lists?: ClickUpList[];
};

export type ClickUpStatus = {
  id?: string;
  status: string;
  type?: string;
  orderindex?: number;
};

export type ClickUpList = {
  id: string;
  name: string;
  archived?: boolean;
  statuses?: ClickUpStatus[];
  folder?: { id: string; name: string } | null;
  space?: { id: string; name: string } | null;
};

export type ClickUpTarefa = {
  id: string;
  custom_id?: string | null;
  name: string;
  description?: string | null;
  text_content?: string | null;
  status?: { status: string; type?: string } | null;
  /** Milissegundos em string — a API devolve number-as-string em vários campos. */
  date_created?: string | null;
  date_updated?: string | null;
  due_date?: string | null;
  start_date?: string | null;
  priority?: { id?: string; priority?: string } | null;
  assignees?: ClickUpUsuario[];
  tags?: Array<{ name: string }>;
  url?: string;
  list?: { id: string; name?: string };
  folder?: { id: string; name?: string };
  space?: { id: string; name?: string };
  parent?: string | null;
};

export type ClickUpComentario = {
  id: string;
  comment_text?: string | null;
  user?: ClickUpUsuario;
  date?: string | null;
  resolved?: boolean;
};

export type ClickUpTag = {
  name: string;
  tag_fg?: string | null;
  tag_bg?: string | null;
};

export type ClickUpItemChecklist = {
  id: string;
  name: string;
  resolved?: boolean;
};

export type ClickUpChecklist = {
  id: string;
  name: string;
  task_id?: string;
  items?: ClickUpItemChecklist[];
};

export type ClickUpRegistroDeTempo = {
  id: string;
  /** Milissegundos em string, como o resto da API. */
  start?: string | null;
  end?: string | null;
  duration?: string | null;
  description?: string | null;
  user?: ClickUpUsuario;
  task?: { id: string; name?: string } | null;
};

export type ClickUpCampoPersonalizado = {
  id: string;
  name: string;
  type: string;
  type_config?: {
    options?: Array<{ id: string; name?: string; label?: string }>;
  };
};

/** 1 urgente · 2 alta · 3 normal · 4 baixa — a ordem é do ClickUp, não nossa. */
export const PRIORIDADES = {
  urgente: 1,
  alta: 2,
  normal: 3,
  baixa: 4,
} as const;

export type NomePrioridade = keyof typeof PRIORIDADES;

/** Como a API devolve: `priority` vem em inglês, `id` vem como "1".."4". */
const EM_INGLES: Record<string, NomePrioridade> = {
  urgent: "urgente",
  high: "alta",
  normal: "normal",
  low: "baixa",
};

/**
 * Aceita as três formas que aparecem na prática: o id numérico, o nome em
 * inglês da API e o nome em português que usamos nas tools.
 */
export function nomeDaPrioridade(valor?: string | null): NomePrioridade | null {
  if (!valor) return null;
  const alvo = String(valor).toLowerCase().trim();

  if (alvo in EM_INGLES) return EM_INGLES[alvo];
  if (alvo in PRIORIDADES) return alvo as NomePrioridade;

  const porId = Object.entries(PRIORIDADES).find(([, id]) => String(id) === alvo);
  return (porId?.[0] as NomePrioridade) ?? null;
}
