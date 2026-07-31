import type { ChatwootConfig } from "./config";

/**
 * Cliente mínimo da API do Chatwoot, autenticado com o `api_access_token` do
 * Agent Bot. Só o que o atendimento precisa — não é um SDK completo.
 */
export class ChatwootClient {
  /**
   * @param token     Token do Agent Bot. **Escreve**: manda mensagem, muda
   *                  status, atribui, aplica rótulo.
   * @param tokenDeLeitura Token de um usuário do Chatwoot. **Lê**: estado da
   *                  conversa e histórico de mensagens.
   *
   * Dois tokens porque o Chatwoot separa isso e recusa leitura de bot com
   * `Access to this endpoint is not authorized for bots` (constatado em
   * produção, 2026-07-31). Sem o de leitura, o worker não consegue nem aplicar
   * as regras globais nem montar o histórico — o atendimento morre antes de
   * começar. Ausente, cai para o do bot, que é o comportamento antigo.
   */
  constructor(
    private readonly config: ChatwootConfig,
    private readonly token: string,
    private readonly tokenDeLeitura?: string | null,
  ) {}

  private url(caminho: string) {
    return `${this.config.baseUrl}/api/v1/accounts/${this.config.accountId}${caminho}`;
  }

  private async requisitar<T>(
    caminho: string,
    init: RequestInit = {},
    /** Leitura usa o token de usuário quando existe. */
    leitura = false,
  ): Promise<T> {
    const usandoTokenDeLeitura = leitura && Boolean(this.tokenDeLeitura);

    const resposta = await fetch(this.url(caminho), {
      ...init,
      headers: {
        api_access_token: usandoTokenDeLeitura
          ? this.tokenDeLeitura!
          : this.token,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => "");

      // O erro mais confuso desta API: o token está certo, só não pode LER.
      // Sem esta tradução, a mensagem no painel não diz o que fazer.
      if (
        resposta.status === 401 &&
        corpo.includes("not authorized for bots") &&
        !usandoTokenDeLeitura
      ) {
        throw new ChatwootApiError(
          resposta.status,
          "o token do Agent Bot não tem permissão de leitura no Chatwoot. " +
            "Configure o token de leitura em Integrações → Chatwoot (token de acesso de um usuário).",
        );
      }

      throw new ChatwootApiError(resposta.status, corpo.slice(0, 300));
    }

    if (resposta.status === 204) return undefined as T;
    return (await resposta.json()) as T;
  }

  /**
   * Testa o que dá para testar de fora de um atendimento.
   *
   * ⚠ O token de **Agent Bot** do Chatwoot é restrito: ele age dentro das
   * conversas das caixas em que o bot está vinculado, e **não** lista conversas
   * da conta. Então 401 no endpoint amplo abaixo é o comportamento esperado de
   * um token de bot correto — chamar isso de "token recusado" mandava o
   * operador trocar uma credencial que estava certa (relatado em 2026-07-31).
   *
   * O que este teste consegue afirmar: a instância responde e a conta existe.
   * Quem valida o token de verdade é a primeira mensagem real.
   */
  async testar(): Promise<{
    ok: boolean;
    mensagem: string;
    indeterminado?: boolean;
  }> {
    try {
      await this.requisitar("/conversations?status=all&page=1", {}, true);
      return {
        ok: true,
        mensagem:
          "Conexão bem-sucedida. Este token tem acesso amplo à conta — se era para ser um Agent Bot, confira se não colou um token pessoal.",
      };
    } catch (erro) {
      if (!(erro instanceof ChatwootApiError)) {
        return {
          ok: false,
          mensagem:
            erro instanceof Error
              ? `Falha de rede: ${erro.message}`
              : "Falha desconhecida.",
        };
      }

      if (erro.status === 401 || erro.status === 403) {
        // Separa "instância/conta erradas" de "token só não pode listar".
        const instancia = await this.instanciaResponde();
        if (!instancia.ok) return instancia;

        return {
          ok: false,
          indeterminado: true,
          mensagem:
            "A instância respondeu, mas este token não lista conversas da conta — o que é o esperado de um Agent Bot. Não dá para confirmar a credencial por aqui: vincule o bot a uma caixa de entrada no Chatwoot e mande uma mensagem de teste. O resultado aparece em Conversas e Execuções.",
        };
      }

      if (erro.status === 404) {
        return {
          ok: false,
          mensagem: "Não encontrado. Confira a URL da instância e o id da conta.",
        };
      }

      return { ok: false, mensagem: `Chatwoot respondeu ${erro.status}.` };
    }
  }

  /**
   * A instância está no ar e é um Chatwoot?
   *
   * Sem token: separa erro de URL/rede de erro de permissão. Qualquer resposta
   * HTTP serve — o que importa é o host existir e falar.
   */
  private async instanciaResponde(): Promise<{ ok: boolean; mensagem: string }> {
    try {
      await fetch(`${this.config.baseUrl}/api`, {
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: true, mensagem: "" };
    } catch (erro) {
      return {
        ok: false,
        mensagem: `A instância não respondeu em ${this.config.baseUrl} — confira a URL. (${
          erro instanceof Error ? erro.message : "erro de rede"
        })`,
      };
    }
  }

  /**
   * Estado atual da conversa direto do Chatwoot.
   *
   * É a fonte da verdade das regras globais: consultado imediatamente antes de
   * responder, fecha a janela entre o humano assumir e o agente enviar. Não
   * depende de qual webhook o Agent Bot recebe.
   */
  async obterConversa(conversationId: number) {
    const bruta = await this.requisitar<{
      id: number;
      status?: string;
      inbox_id?: number | null;
      labels?: string[] | null;
      meta?: { assignee?: { id?: number } | null };
      assignee_id?: number | null;
    }>(`/conversations/${conversationId}`, {}, true);

    return {
      status: bruta.status ?? null,
      assigneeId: bruta.assignee_id ?? bruta.meta?.assignee?.id ?? null,
      inboxId: bruta.inbox_id ?? null,
      // Quem decide se outro bot é o dono da conversa. Vem vazio se a instância
      // não devolver o campo — nesse caso a regra de label simplesmente não casa.
      labels: bruta.labels ?? [],
    };
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
      {},
      true,
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

  async listarLabels(conversationId: number): Promise<string[]> {
    const resposta = await this.requisitar<{ payload?: string[] }>(
      `/conversations/${conversationId}/labels`,
      {},
      true,
    );
    return resposta.payload ?? [];
  }

  /**
   * **Substitui** a lista inteira de labels da conversa.
   *
   * O endpoint do Chatwoot é `update_labels`, não "append": mandar um label
   * apaga todos os outros. O nome aqui é explícito de propósito — quem quer
   * acrescentar deve usar `adicionarLabel`.
   */
  async definirLabels(conversationId: number, labels: string[]) {
    return this.requisitar(`/conversations/${conversationId}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels }),
    });
  }

  /**
   * Acrescenta preservando os que já existem.
   *
   * Vale o custo do GET: labels são o combinado entre nós e qualquer outro bot
   * na mesma caixa (um fluxo do n8n, por exemplo). Apagar o label do outro é
   * apagar o critério que decide quem responde.
   */
  async adicionarLabel(conversationId: number, label: string) {
    const atuais = await this.listarLabels(conversationId);
    if (atuais.includes(label)) return { labels: atuais, mudou: false };

    const novos = [...atuais, label];
    await this.definirLabels(conversationId, novos);
    return { labels: novos, mudou: true };
  }

  async removerLabel(conversationId: number, label: string) {
    const atuais = await this.listarLabels(conversationId);
    if (!atuais.includes(label)) return { labels: atuais, mudou: false };

    const novos = atuais.filter((l) => l !== label);
    await this.definirLabels(conversationId, novos);
    return { labels: novos, mudou: true };
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
