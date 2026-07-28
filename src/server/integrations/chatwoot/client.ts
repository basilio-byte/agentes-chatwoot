import type { ChatwootConfig } from "./config";

/**
 * Cliente mínimo da API do Chatwoot, autenticado com o `api_access_token` do
 * Agent Bot. Só o que o atendimento precisa — não é um SDK completo.
 */
export class ChatwootClient {
  constructor(
    private readonly config: ChatwootConfig,
    private readonly token: string,
  ) {}

  private url(caminho: string) {
    return `${this.config.baseUrl}/api/v1/accounts/${this.config.accountId}${caminho}`;
  }

  private async requisitar<T>(
    caminho: string,
    init: RequestInit = {},
  ): Promise<T> {
    const resposta = await fetch(this.url(caminho), {
      ...init,
      headers: {
        api_access_token: this.token,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => "");
      throw new ChatwootApiError(resposta.status, corpo.slice(0, 300));
    }

    if (resposta.status === 204) return undefined as T;
    return (await resposta.json()) as T;
  }

  /**
   * Testa credencial + configuração de uma vez.
   *
   * Traduz o status HTTP para uma causa provável — 401 e 404 significam coisas
   * bem diferentes aqui e o operador precisa saber qual dos dois é.
   */
  async testar(): Promise<{ ok: boolean; mensagem: string }> {
    try {
      await this.requisitar("/conversations?status=all&page=1");
      return { ok: true, mensagem: "Conexão bem-sucedida." };
    } catch (erro) {
      if (erro instanceof ChatwootApiError) {
        if (erro.status === 401 || erro.status === 403) {
          return {
            ok: false,
            mensagem:
              "Token recusado. Confira se é o access token do Agent Bot (não o token pessoal de agente).",
          };
        }
        if (erro.status === 404) {
          return {
            ok: false,
            mensagem:
              "Não encontrado. Confira a URL da instância e o id da conta.",
          };
        }
        return { ok: false, mensagem: `Chatwoot respondeu ${erro.status}.` };
      }
      return {
        ok: false,
        mensagem:
          erro instanceof Error
            ? `Falha de rede: ${erro.message}`
            : "Falha desconhecida.",
      };
    }
  }

  /**
   * Mensagens da conversa, da mais antiga para a mais recente.
   *
   * Atenção ao `message_type`: aqui ele é **numérico** (0 entrada, 1 saída,
   * 2 atividade, 3 template), enquanto no webhook vem como string. Confundir os
   * dois faz o bot ler as próprias respostas como se fossem do cliente.
   */
  async listarMensagens(conversationId: number) {
    const resposta = await this.requisitar<{ payload?: MensagemChatwoot[] }>(
      `/conversations/${conversationId}/messages`,
    );
    return resposta.payload ?? [];
  }

  async enviarMensagem(
    conversationId: number,
    conteudo: string,
    opcoes: { privado?: boolean } = {},
  ) {
    return this.requisitar<{ id: number }>(
      `/conversations/${conversationId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          content: conteudo,
          message_type: "outgoing",
          private: opcoes.privado ?? false,
        }),
      },
    );
  }

  /** `open` devolve a conversa para a fila humana; `pending` volta para o bot. */
  async alternarStatus(conversationId: number, status: "open" | "pending" | "resolved") {
    return this.requisitar(`/conversations/${conversationId}/toggle_status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    });
  }

  async atribuir(
    conversationId: number,
    destino: { assigneeId?: number; teamId?: number },
  ) {
    return this.requisitar(`/conversations/${conversationId}/assignments`, {
      method: "POST",
      body: JSON.stringify({
        ...(destino.assigneeId ? { assignee_id: destino.assigneeId } : {}),
        ...(destino.teamId ? { team_id: destino.teamId } : {}),
      }),
    });
  }

  async adicionarLabels(conversationId: number, labels: string[]) {
    return this.requisitar(`/conversations/${conversationId}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels }),
    });
  }
}

export type MensagemChatwoot = {
  id: number;
  content: string | null;
  /** 0 entrada · 1 saída · 2 atividade · 3 template */
  message_type: number;
  private?: boolean;
  created_at?: number;
};

export class ChatwootApiError extends Error {
  constructor(
    readonly status: number,
    readonly corpo: string,
  ) {
    super(`Chatwoot respondeu ${status}: ${corpo}`);
    this.name = "ChatwootApiError";
  }
}
