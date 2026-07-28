import type {
  ClickUpComentario,
  ClickUpFolder,
  ClickUpList,
  ClickUpSpace,
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
}
