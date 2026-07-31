import {
  corpoJsonApi,
  prazoDeAssinatura,
  type Autenticacao,
  type ClickSignConfig,
  type Papel,
} from "./config";

export class ClickSignApiError extends Error {
  constructor(
    readonly status: number,
    readonly corpo: string,
  ) {
    super(`ClickSign respondeu ${status}: ${corpo}`);
    this.name = "ClickSignApiError";
  }
}

type Recurso = { data: { id: string; type: string; attributes?: Record<string, unknown> } };

export type SignatarioClickSign = {
  /** A ClickSign exige nome com **duas palavras** — recusa "João" sozinho. */
  name: string;
  email?: string;
  /** Só dígitos, 10 ou 11. Obrigatório se a notificação for SMS ou WhatsApp. */
  phone_number?: string;
  documentation?: string;
  birthday?: string;
  has_documentation?: boolean;
  refusable?: boolean;
  /** Ordem de assinatura. */
  group?: number;
  /** Como o signatário é avisado. `whatsapp` entrega no número dele. */
  communicate_events?: {
    signature_request?: "none" | "email" | "whatsapp" | "sms";
    signature_reminder?: "none" | "email";
    document_signed?: "email" | "whatsapp";
  };
};

/**
 * Cliente da API v3 (Envelopes) da ClickSign.
 *
 * Duas armadilhas que são o **oposto** da ZapSign, e por isso fáceis de trocar
 * quando as duas integrações convivem no mesmo projeto:
 *
 * 1. O token vai **cru** no `Authorization` — sem `Bearer`. Com o prefixo, a
 *    API recusa.
 * 2. O `Content-Type` é `application/vnd.api+json`, não `application/json`.
 *
 * Ambas têm teste.
 */
export class ClickSignClient {
  constructor(
    private readonly config: ClickSignConfig,
    private readonly token: string,
  ) {}

  private async requisitar<T>(caminho: string, init: RequestInit = {}): Promise<T> {
    const base = this.config.baseUrl.replace(/\/$/, "");

    const resposta = await fetch(`${base}${caminho}`, {
      ...init,
      headers: {
        // Sem "Bearer": a ClickSign quer o token puro.
        Authorization: this.token,
        "Content-Type": "application/vnd.api+json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => "");
      throw new ClickSignApiError(resposta.status, corpo.slice(0, 400));
    }

    if (resposta.status === 204) return undefined as T;
    return (await resposta.json()) as T;
  }

  private post<T>(caminho: string, corpo: unknown) {
    return this.requisitar<T>(caminho, { method: "POST", body: JSON.stringify(corpo) });
  }

  // ─── Passos do envelope ──────────────────────────────────────────────────

  criarEnvelope(dados: { name: string; deadline_at?: string; message?: string }) {
    return this.post<Recurso>(
      "/envelopes",
      corpoJsonApi("envelopes", {
        name: dados.name,
        locale: this.config.locale,
        auto_close: this.config.fecharAutomaticamente,
        deadline_at: dados.deadline_at ?? prazoDeAssinatura(this.config.prazoEmDias),
        ...(dados.message ? { default_message: dados.message } : {}),
      }),
    );
  }

  /** Aceita PDF, DOCX, DOC, TXT, PNG e JPEG — sempre em base64. */
  enviarDocumento(envelopeId: string, dados: { filename: string; base64: string }) {
    return this.post<Recurso>(
      `/envelopes/${envelopeId}/documents`,
      corpoJsonApi("documents", {
        filename: dados.filename,
        content_base64: dados.base64,
      }),
    );
  }

  criarSignatario(envelopeId: string, signatario: SignatarioClickSign) {
    return this.post<Recurso>(
      `/envelopes/${envelopeId}/signers`,
      corpoJsonApi("signers", { ...signatario }),
    );
  }

  /** Diz **como** o signatário se autentica. Sem pelo menos um, o envelope não ativa. */
  exigirAutenticacao(
    envelopeId: string,
    dados: { documentId: string; signerId: string; auth?: Autenticacao },
  ) {
    return this.post<Recurso>(
      `/envelopes/${envelopeId}/requirements`,
      corpoJsonApi(
        "requirements",
        { action: "provide_evidence", auth: dados.auth ?? this.config.autenticacaoPadrao },
        {
          document: { type: "documents", id: dados.documentId },
          signer: { type: "signers", id: dados.signerId },
        },
      ),
    );
  }

  /** Diz **em que papel** o signatário assina. */
  exigirQualificacao(
    envelopeId: string,
    dados: { documentId: string; signerId: string; role?: Papel },
  ) {
    return this.post<Recurso>(
      `/envelopes/${envelopeId}/requirements`,
      corpoJsonApi(
        "requirements",
        { action: "agree", role: dados.role ?? "sign" },
        {
          document: { type: "documents", id: dados.documentId },
          signer: { type: "signers", id: dados.signerId },
        },
      ),
    );
  }

  /**
   * Ativa o envelope: `draft` → `running`, e as notificações saem.
   *
   * Não tem volta — `running` não retorna para `draft`.
   */
  ativar(envelopeId: string) {
    return this.requisitar<Recurso>(`/envelopes/${envelopeId}`, {
      method: "PATCH",
      body: JSON.stringify({
        data: { id: envelopeId, type: "envelopes", attributes: { status: "running" } },
      }),
    });
  }

  notificarSignatario(envelopeId: string, signerId: string, mensagem?: string) {
    return this.post<Recurso>(
      `/envelopes/${envelopeId}/signers/${signerId}/notifications`,
      corpoJsonApi("notifications", mensagem ? { message: mensagem } : {}),
    );
  }

  detalharEnvelope(envelopeId: string) {
    return this.requisitar<Recurso>(`/envelopes/${envelopeId}`);
  }

  // ─── Caminho completo, em uma chamada ────────────────────────────────────

  /**
   * Cria, monta e ativa o envelope de uma vez.
   *
   * Existe porque o caminho mínimo da ClickSign são **cinco** requisições
   * (envelope → documento → signatário → requisito de autenticação → requisito
   * de qualificação → ativar), e cada signatário acrescenta três. Um agente
   * fazendo isso passo a passo estoura o teto de rodadas de tool antes de
   * terminar — foi exatamente o que aconteceu com os campos personalizados do
   * ClickUp, e a lição foi: quando o caminho certo é caro, o modelo pega o
   * atalho errado.
   *
   * Devolve os ids de tudo, para o chamador poder auditar o que foi criado
   * mesmo quando algo falha no meio.
   */
  async enviarParaAssinatura(dados: {
    nome: string;
    arquivo: { filename: string; base64: string };
    signatarios: (SignatarioClickSign & { auth?: Autenticacao; role?: Papel })[];
    mensagem?: string;
    prazoEmDias?: number;
  }) {
    if (!dados.signatarios.length) {
      throw new Error("Um envelope sem signatário não pode ser ativado.");
    }

    const envelope = await this.criarEnvelope({
      name: dados.nome,
      message: dados.mensagem,
      deadline_at: dados.prazoEmDias
        ? prazoDeAssinatura(dados.prazoEmDias)
        : undefined,
    });
    const envelopeId = envelope.data.id;

    const documento = await this.enviarDocumento(envelopeId, {
      filename: dados.arquivo.filename,
      base64: dados.arquivo.base64,
    });
    const documentId = documento.data.id;

    const criados: { signerId: string; nome: string }[] = [];

    for (const { auth, role, ...signatario } of dados.signatarios) {
      const signer = await this.criarSignatario(envelopeId, signatario);
      const signerId = signer.data.id;

      // A ordem importa: sem requisito de autenticação, `ativar` devolve 422.
      await this.exigirAutenticacao(envelopeId, { documentId, signerId, auth });
      await this.exigirQualificacao(envelopeId, { documentId, signerId, role });

      criados.push({ signerId, nome: signatario.name });
    }

    await this.ativar(envelopeId);

    return { envelopeId, documentId, signatarios: criados };
  }

  async testar(): Promise<{ ok: boolean; mensagem: string }> {
    try {
      await this.requisitar("/envelopes?page[number]=1");
      return {
        ok: true,
        mensagem: "Conexão bem-sucedida. A URL e o Access Token respondem.",
      };
    } catch (erro) {
      if (!(erro instanceof ClickSignApiError)) {
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
            "Access Token recusado. Confira se ele é do mesmo ambiente da URL — token de sandbox não funciona em produção.",
        };
      }
      if (erro.status === 503) {
        return {
          ok: false,
          mensagem:
            "A ClickSign respondeu 503: normalmente significa que o recurso de Envelopes (API v3) não está habilitado nesta conta. Fale com o gerente de conta.",
        };
      }
      return { ok: false, mensagem: `ClickSign respondeu ${erro.status}.` };
    }
  }
}
