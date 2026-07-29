import type {
  ClickUpCampoPersonalizado,
  ClickUpChecklist,
  ClickUpComentario,
  ClickUpFolder,
  ClickUpList,
  ClickUpRegistroDeTempo,
  ClickUpSpace,
  ClickUpTag,
  ClickUpTarefa,
  ClickUpWorkspace,
} from "./tipos";

const BASE = "https://api.clickup.com/api/v2";

export class ClickUpApiError extends Error {
  constructor(
    readonly status: number,
    readonly corpo: string,
  ) {
    super(`ClickUp respondeu ${status}: ${corpo}`);
    this.name = "ClickUpApiError";
  }
}

export type OpcoesBusca = {
  listIds?: string[];
  spaceIds?: string[];
  statuses?: string[];
  assignees?: number[];
  incluirFechadas?: boolean;
  vencimentoAntesDe?: number;
  vencimentoDepoisDe?: number;
  page?: number;
};

/**
 * Cliente da API v2 do ClickUp.
 *
 * Token pessoal vai cru no header `Authorization` — sem `Bearer`, que é o que a
 * documentação deles especifica e engana quem vem de outras APIs.
 */
export class ClickUpClient {
  constructor(private readonly token: string) {}

  private async requisitar<T>(
    caminho: string,
    init: RequestInit = {},
    tentativa = 0,
  ): Promise<T> {
    const resposta = await fetch(`${BASE}${caminho}`, {
      ...init,
      headers: {
        Authorization: this.token,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });

    // 429: o ClickUp limita por minuto. Uma re-tentativa respeitando o header
    // resolve o caso comum sem derrubar o atendimento.
    if (resposta.status === 429 && tentativa < 2) {
      const espera = Number(resposta.headers.get("retry-after") ?? "5");
      await new Promise((r) => setTimeout(r, Math.min(espera, 30) * 1000));
      return this.requisitar<T>(caminho, init, tentativa + 1);
    }

    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => "");
      throw new ClickUpApiError(resposta.status, corpo.slice(0, 300));
    }

    if (resposta.status === 204) return undefined as T;
    return (await resposta.json()) as T;
  }

  // --- diagnóstico ---------------------------------------------------------

  async testar(): Promise<{ ok: boolean; mensagem: string }> {
    try {
      const { teams } = await this.listarWorkspaces();
      return {
        ok: true,
        mensagem:
          teams.length === 1
            ? `Conectado ao workspace "${teams[0].name}".`
            : `Conectado. ${teams.length} workspaces disponíveis.`,
      };
    } catch (erro) {
      if (erro instanceof ClickUpApiError) {
        if (erro.status === 401) {
          return {
            ok: false,
            mensagem:
              "Token recusado. Confira se copiou o token pessoal inteiro (começa com pk_).",
          };
        }
        return { ok: false, mensagem: `ClickUp respondeu ${erro.status}.` };
      }
      return {
        ok: false,
        mensagem:
          erro instanceof Error ? `Falha de rede: ${erro.message}` : "Falha desconhecida.",
      };
    }
  }

  // --- hierarquia ----------------------------------------------------------

  listarWorkspaces() {
    return this.requisitar<{ teams: ClickUpWorkspace[] }>("/team");
  }

  listarSpaces(teamId: string) {
    return this.requisitar<{ spaces: ClickUpSpace[] }>(`/team/${teamId}/space`);
  }

  listarFolders(spaceId: string) {
    return this.requisitar<{ folders: ClickUpFolder[] }>(
      `/space/${spaceId}/folder`,
    );
  }

  listarListasDaFolder(folderId: string) {
    return this.requisitar<{ lists: ClickUpList[] }>(`/folder/${folderId}/list`);
  }

  /** Listas soltas no espaço, fora de qualquer pasta. */
  listarListasSemFolder(spaceId: string) {
    return this.requisitar<{ lists: ClickUpList[] }>(`/space/${spaceId}/list`);
  }

  /** Traz os `statuses` válidos da lista — necessário para atualizar status. */
  obterLista(listId: string) {
    return this.requisitar<ClickUpList>(`/list/${listId}`);
  }

  // --- tarefas -------------------------------------------------------------

  obterTarefa(taskId: string) {
    return this.requisitar<ClickUpTarefa>(`/task/${taskId}`);
  }

  listarTarefasDaLista(listId: string, opcoes: OpcoesBusca = {}) {
    const q = new URLSearchParams();
    q.set("page", String(opcoes.page ?? 0));
    if (opcoes.incluirFechadas) q.set("include_closed", "true");
    opcoes.statuses?.forEach((s) => q.append("statuses[]", s));
    opcoes.assignees?.forEach((a) => q.append("assignees[]", String(a)));

    return this.requisitar<{ tasks: ClickUpTarefa[] }>(
      `/list/${listId}/task?${q}`,
    );
  }

  /**
   * Busca no workspace inteiro, com filtros estruturados.
   *
   * A API **não tem busca textual** — quem precisa casar por nome filtra o
   * resultado no cliente.
   */
  buscarTarefas(teamId: string, opcoes: OpcoesBusca = {}) {
    const q = new URLSearchParams();
    q.set("page", String(opcoes.page ?? 0));
    if (opcoes.incluirFechadas) q.set("include_closed", "true");
    opcoes.listIds?.forEach((l) => q.append("list_ids[]", l));
    opcoes.spaceIds?.forEach((s) => q.append("space_ids[]", s));
    opcoes.statuses?.forEach((s) => q.append("statuses[]", s));
    opcoes.assignees?.forEach((a) => q.append("assignees[]", String(a)));
    if (opcoes.vencimentoAntesDe)
      q.set("due_date_lt", String(opcoes.vencimentoAntesDe));
    if (opcoes.vencimentoDepoisDe)
      q.set("due_date_gt", String(opcoes.vencimentoDepoisDe));

    return this.requisitar<{ tasks: ClickUpTarefa[] }>(
      `/team/${teamId}/task?${q}`,
    );
  }

  /**
   * `custom_fields` já no create evita a sequência
   * criar → definir campo → definir campo → … , que estoura o limite de
   * iterações de tool do agente antes de preencher tudo.
   */
  criarTarefa(
    listId: string,
    dados: {
      name: string;
      description?: string;
      status?: string;
      priority?: number | null;
      due_date?: number;
      assignees?: number[];
      tags?: string[];
      parent?: string;
      custom_fields?: { id: string; value: unknown }[];
    },
  ) {
    return this.requisitar<ClickUpTarefa>(`/list/${listId}/task`, {
      method: "POST",
      body: JSON.stringify(dados),
    });
  }

  /**
   * `assignees` no update é **objeto** `{ add, rem }`, não array — diferente do
   * create, onde é array. Trocar os dois é o erro clássico desta API.
   */
  atualizarTarefa(
    taskId: string,
    dados: {
      name?: string;
      description?: string;
      status?: string;
      priority?: number | null;
      due_date?: number;
      archived?: boolean;
      assignees?: { add?: number[]; rem?: number[] };
    },
  ) {
    return this.requisitar<ClickUpTarefa>(`/task/${taskId}`, {
      method: "PUT",
      body: JSON.stringify(dados),
    });
  }

  // --- comentários ---------------------------------------------------------

  listarComentarios(taskId: string) {
    return this.requisitar<{ comments: ClickUpComentario[] }>(
      `/task/${taskId}/comment`,
    );
  }

  comentarTarefa(
    taskId: string,
    texto: string,
    opcoes: { notificarTodos?: boolean; responsavelId?: number } = {},
  ) {
    return this.requisitar<{ id: string }>(`/task/${taskId}/comment`, {
      method: "POST",
      body: JSON.stringify({
        comment_text: texto,
        notify_all: opcoes.notificarTodos ?? false,
        ...(opcoes.responsavelId ? { assignee: opcoes.responsavelId } : {}),
      }),
    });
  }

  /** O comentário é endereçado direto, sem a tarefa no caminho. */
  editarComentario(
    commentId: string,
    dados: { comment_text?: string; resolved?: boolean },
  ) {
    return this.requisitar<unknown>(`/comment/${commentId}`, {
      method: "PUT",
      body: JSON.stringify(dados),
    });
  }

  excluirComentario(commentId: string) {
    return this.requisitar<unknown>(`/comment/${commentId}`, {
      method: "DELETE",
    });
  }

  // --- tarefas: exclusão ---------------------------------------------------

  excluirTarefa(taskId: string) {
    return this.requisitar<unknown>(`/task/${taskId}`, { method: "DELETE" });
  }

  // --- criação de estrutura ------------------------------------------------

  criarFolder(spaceId: string, name: string) {
    return this.requisitar<ClickUpFolder>(`/space/${spaceId}/folder`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  /** Dentro de uma pasta. Para lista solta no espaço use `criarListaEmSpace`. */
  criarListaEmFolder(folderId: string, dados: { name: string; content?: string }) {
    return this.requisitar<ClickUpList>(`/folder/${folderId}/list`, {
      method: "POST",
      body: JSON.stringify(dados),
    });
  }

  criarListaEmSpace(spaceId: string, dados: { name: string; content?: string }) {
    return this.requisitar<ClickUpList>(`/space/${spaceId}/list`, {
      method: "POST",
      body: JSON.stringify(dados),
    });
  }

  // --- tags ----------------------------------------------------------------

  listarTags(spaceId: string) {
    return this.requisitar<{ tags: ClickUpTag[] }>(`/space/${spaceId}/tag`);
  }

  /**
   * A tag vai no **caminho**, não no corpo, e precisa já existir no espaço —
   * a API não cria tag por este endpoint.
   */
  adicionarTag(taskId: string, tag: string) {
    return this.requisitar<unknown>(
      `/task/${taskId}/tag/${encodeURIComponent(tag)}`,
      { method: "POST" },
    );
  }

  /** Tira a tag da tarefa; a tag continua existindo no espaço. */
  removerTag(taskId: string, tag: string) {
    return this.requisitar<unknown>(
      `/task/${taskId}/tag/${encodeURIComponent(tag)}`,
      { method: "DELETE" },
    );
  }

  // --- checklists ----------------------------------------------------------

  criarChecklist(taskId: string, name: string) {
    return this.requisitar<{ checklist: ClickUpChecklist }>(
      `/task/${taskId}/checklist`,
      { method: "POST", body: JSON.stringify({ name }) },
    );
  }

  adicionarItemChecklist(
    checklistId: string,
    dados: { name: string; assignee?: number; resolved?: boolean },
  ) {
    return this.requisitar<{ checklist: ClickUpChecklist }>(
      `/checklist/${checklistId}/checklist_item`,
      { method: "POST", body: JSON.stringify(dados) },
    );
  }

  /** O id do checklist entra no caminho junto com o do item. */
  atualizarItemChecklist(
    checklistId: string,
    itemId: string,
    dados: { name?: string; resolved?: boolean },
  ) {
    return this.requisitar<{ checklist: ClickUpChecklist }>(
      `/checklist/${checklistId}/checklist_item/${itemId}`,
      { method: "PUT", body: JSON.stringify(dados) },
    );
  }

  excluirItemChecklist(checklistId: string, itemId: string) {
    return this.requisitar<unknown>(
      `/checklist/${checklistId}/checklist_item/${itemId}`,
      { method: "DELETE" },
    );
  }

  // --- registro de tempo ---------------------------------------------------

  /**
   * O cronômetro é sempre do **dono do token** — a API não permite iniciar
   * tempo em nome de outra pessoa.
   */
  iniciarCronometro(
    teamId: string,
    dados: { tid: string; description?: string; billable?: boolean },
  ) {
    return this.requisitar<{ data: ClickUpRegistroDeTempo }>(
      `/team/${teamId}/time_entries/start`,
      { method: "POST", body: JSON.stringify(dados) },
    );
  }

  pararCronometro(teamId: string) {
    return this.requisitar<{ data: ClickUpRegistroDeTempo }>(
      `/team/${teamId}/time_entries/stop`,
      { method: "POST" },
    );
  }

  /** `start` e `duration` em milissegundos. */
  registrarTempo(
    teamId: string,
    dados: {
      tid: string;
      start: number;
      duration: number;
      description?: string;
      billable?: boolean;
    },
  ) {
    return this.requisitar<{ data: ClickUpRegistroDeTempo }>(
      `/team/${teamId}/time_entries`,
      { method: "POST", body: JSON.stringify(dados) },
    );
  }

  listarRegistrosDeTempo(
    teamId: string,
    opcoes: { taskId?: string; inicio?: number; fim?: number } = {},
  ) {
    const q = new URLSearchParams();
    if (opcoes.taskId) q.set("task_id", opcoes.taskId);
    if (opcoes.inicio) q.set("start_date", String(opcoes.inicio));
    if (opcoes.fim) q.set("end_date", String(opcoes.fim));

    const query = q.toString();
    return this.requisitar<{ data: ClickUpRegistroDeTempo[] }>(
      `/team/${teamId}/time_entries${query ? `?${query}` : ""}`,
    );
  }

  // --- relacionamentos -----------------------------------------------------

  /**
   * `depends_on`: esta tarefa espera a outra.
   * `dependency_of`: a outra espera esta.
   */
  definirDependencia(
    taskId: string,
    dados: { depends_on?: string; dependency_of?: string },
  ) {
    return this.requisitar<unknown>(`/task/${taskId}/dependency`, {
      method: "POST",
      body: JSON.stringify(dados),
    });
  }

  /** Vínculo simples entre duas tarefas — ambos os ids vão no caminho. */
  vincularTarefas(taskId: string, outraTarefaId: string) {
    return this.requisitar<{ task: ClickUpTarefa }>(
      `/task/${taskId}/link/${outraTarefaId}`,
      { method: "POST" },
    );
  }

  // --- campos personalizados -----------------------------------------------

  listarCamposPersonalizados(listId: string) {
    return this.requisitar<{ fields: ClickUpCampoPersonalizado[] }>(
      `/list/${listId}/field`,
    );
  }

  /** O valor vai em `{ value }`; o formato depende do tipo do campo. */
  definirCampoPersonalizado(taskId: string, fieldId: string, value: unknown) {
    return this.requisitar<unknown>(`/task/${taskId}/field/${fieldId}`, {
      method: "POST",
      body: JSON.stringify({ value }),
    });
  }
}
