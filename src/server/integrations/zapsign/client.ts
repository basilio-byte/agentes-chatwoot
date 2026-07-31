import type { AuthMode, ZapSignConfig } from "./config";

export class ZapSignApiError extends Error {
  constructor(
    readonly status: number,
    readonly corpo: string,
  ) {
    super(`ZapSign respondeu ${status}: ${corpo}`);
    this.name = "ZapSignApiError";
  }
}

export type Signatario = {
  name: string;
  email?: string;
  phone_country?: string;
  phone_number?: string;
  auth_mode?: AuthMode;
  send_automatic_email?: boolean;
  send_automatic_whatsapp?: boolean;
  cpf?: string;
  qualification?: string;
};

export type DocumentoCriado = {
  token: string;
  status: string;
  name: string;
  original_file?: string | null;
  signed_file?: string | null;
  signers?: { token: string; sign_url: string; name: string; status: string }[];
};

/**
 * Cliente da API v1 da ZapSign.
 *
 * ⚠ **A barra final das rotas não é decorativa.** A API é Django REST, e
 * `/docs` sem barra responde redirect ou 404 conforme o método — o POST some no
 * caminho. Todas as rotas aqui terminam em `/`, e há teste travando isso.
 */
export class ZapSignClient {
  constructor(
    private readonly config: ZapSignConfig,
    private readonly token: string,
  ) {}

  private async requisitar<T>(
    caminho: string,
    init: RequestInit = {},
    query?: Record<string, unknown>,
  ): Promise<T> {
    const base = this.config.baseUrl.replace(/\/$/, "");
    const url = new URL(`${base}${caminho}`);
    for (const [chave, valor] of Object.entries(query ?? {})) {
      if (valor === undefined || valor === null || valor === "") continue;
      url.searchParams.set(chave, String(valor));
    }

    const resposta = await fetch(url.toString(), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => "");
      throw new ZapSignApiError(resposta.status, corpo.slice(0, 400));
    }

    if (resposta.status === 204) return undefined as T;
    return (await resposta.json()) as T;
  }

  /** Preenche o que a configuração define e o fluxo não disse. */
  private comPadroes(signatarios: Signatario[]): Signatario[] {
    return signatarios.map((s) => ({
      ...s,
      auth_mode: s.auth_mode ?? this.config.authModePadrao,
      send_automatic_whatsapp:
        s.send_automatic_whatsapp ?? this.config.whatsappAutomatico,
    }));
  }

  /**
   * Cria documento a partir de um PDF/DOCX (por URL pública ou base64) ou de
   * markdown.
   */
  criarDocumento(dados: {
    name: string;
    url_pdf?: string;
    base64_pdf?: string;
    url_docx?: string;
    base64_docx?: string;
    markdown_text?: string;
    signers: Signatario[];
    external_id?: string;
    folder_path?: string;
    date_limit_to_sign?: string;
    signature_order_active?: boolean;
  }) {
    const { signers, ...resto } = dados;
    return this.requisitar<DocumentoCriado>("/docs/", {
      method: "POST",
      body: JSON.stringify({
        lang: this.config.lang,
        ...resto,
        signers: this.comPadroes(signers),
      }),
    });
  }

  /**
   * Cria documento a partir de um modelo DOCX, substituindo as variáveis.
   *
   * É o caminho que interessa para contrato: o modelo já está pronto e formatado
   * na ZapSign, e o agente só manda os valores.
   */
  criarPorModelo(dados: {
    template_id: string;
    signer_name: string;
    data: { de: string; para: string }[];
    signer_email?: string;
    signer_phone_country?: string;
    signer_phone_number?: string;
    send_automatic_email?: boolean;
    send_automatic_whatsapp?: boolean;
    external_id?: string;
    folder_path?: string;
  }) {
    return this.requisitar<DocumentoCriado>("/models/create-doc/", {
      method: "POST",
      body: JSON.stringify({
        lang: this.config.lang,
        send_automatic_whatsapp: this.config.whatsappAutomatico,
        ...dados,
      }),
    });
  }

  /**
   * Estado do documento e de cada signatário.
   *
   * ⚠ `original_file` e `signed_file` **expiram em 60 minutos**. Guardar a URL
   * é guardar um link morto: leia de novo na hora de usar.
   */
  detalhar(docToken: string) {
    return this.requisitar<DocumentoCriado>(`/docs/${docToken}/`);
  }

  adicionarSignatario(docToken: string, signatario: Signatario) {
    return this.requisitar<{ token: string; sign_url: string }>(
      `/docs/${docToken}/add-signer/`,
      {
        method: "POST",
        body: JSON.stringify(this.comPadroes([signatario])[0]),
      },
    );
  }

  /**
   * Lista documentos.
   *
   * ⚠ A ZapSign cacheia esta rota por 60 segundos: documento recém-criado pode
   * não aparecer. Para conferir algo que você acabou de criar, use `detalhar`.
   */
  listar(filtros: {
    page?: number;
    status?: "pending" | "signed" | "refused";
    folder_path?: string;
    signer_email?: string;
    created_from?: string;
    created_to?: string;
    include_signers?: boolean;
  } = {}) {
    return this.requisitar<{
      count: number;
      next: string | null;
      results: DocumentoCriado[];
    }>("/docs/", {}, { page: 1, ...filtros });
  }

  async testar(): Promise<{ ok: boolean; mensagem: string }> {
    try {
      const { count } = await this.listar({ page: 1 });
      return {
        ok: true,
        mensagem: `Conexão bem-sucedida. A conta tem ${count} documento(s).`,
      };
    } catch (erro) {
      if (!(erro instanceof ZapSignApiError)) {
        return {
          ok: false,
          mensagem:
            erro instanceof Error
              ? `Falha de rede: ${erro.message}`
              : "Falha desconhecida.",
        };
      }
      if (erro.status === 401 || erro.status === 403) {
        return {
          ok: false,
          mensagem:
            "Token recusado. Confira o API Token em Configurações → Integrações na ZapSign, e se ele é do ambiente certo (produção x testes).",
        };
      }
      return { ok: false, mensagem: `ZapSign respondeu ${erro.status}.` };
    }
  }
}
