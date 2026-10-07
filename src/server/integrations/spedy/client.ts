/**
 * Cliente da Spedy (NFS-e), escrito à mão como o do ClickUp, do Conexa e da
 * ZapSign: `fetch` e nada mais.
 *
 * - **Uma chave por empresa** (`X-Api-Key`). A chave mora na variável de
 *   ambiente `SPEDY_KEY_<EMPRESA>` do servidor, nunca no banco nem na tela.
 * - ⚠ **Produção apenas.** A Spedy tem um sandbox, mas ele é uma conta à parte,
 *   e as chaves da Seahub só abrem a produção. Cada escrita aqui é fiscal e
 *   gasta número da sequência.
 * - ⚠ **Sem cancelar e sem apagar, de propósito.** O `DELETE` da Spedy é
 *   "Cancelar NFS-e" (de nota autorizada, com justificativa), e não apaga
 *   rascunho. Um erro de código aqui nunca pode cancelar uma nota: quem cancela
 *   é uma pessoa, na tela da Spedy.
 * - **Criar é idempotente pelo `integrationId`**: um segundo envio com o mesmo
 *   id atualiza a nota em vez de duplicar. Por isso, depois de um erro de rede,
 *   o certo é procurar pelo id antes de mandar de novo.
 */

const BASE_PADRAO = "https://api.spedy.com.br";
const PRAZO_MS = 30_000;

export class SpedyApiError extends Error {
  constructor(
    readonly status: number,
    mensagem: string,
    readonly corpo?: unknown,
  ) {
    super(mensagem);
    this.name = "SpedyApiError";
  }
}

/** A chamada não chegou a ter resposta: pode ou não ter sido aplicada. */
export class SpedyRedeError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "SpedyRedeError";
  }
}

/**
 * A Spedy RECUSOU o pedido (dado inválido, chave errada): nada foi aplicado e
 * repetir igual dá no mesmo. 408 e 429 são "tente depois", e 5xx é incerto.
 */
export function ehRecusaDefinitiva(erro: unknown): erro is SpedyApiError {
  return (
    erro instanceof SpedyApiError &&
    erro.status >= 400 &&
    erro.status < 500 &&
    erro.status !== 408 &&
    erro.status !== 429
  );
}

export type NotaDaSpedy = {
  id: string;
  integrationId: string | null;
  status: string;
  number: number | null;
  processingDetail: { status?: string; message?: string; code?: string } | null;
};

export type CorpoDeNota = {
  integrationId: string;
  issue: boolean;
  sendEmailToCustomer: boolean;
  effectiveDate?: string;
  description: string;
  nationalTaxationCode: string;
  receiver: {
    name: string;
    federalTaxNumber: string;
    email?: string;
    phoneNumber?: string;
    address: {
      postalCode: string;
      street?: string;
      number?: string;
      district?: string;
      additionalInformation?: string;
      country: string;
      city?: { code?: number; name?: string; state?: string };
    };
  };
  total: { invoiceAmount: number };
};

export class SpedyClient {
  constructor(
    private readonly chave: string,
    private readonly base: string = process.env.SPEDY_BASE_URL ?? BASE_PADRAO,
  ) {}

  /** Cria (e, com `issue: true`, enfileira a emissão de) uma NFS-e. */
  criarNota(corpo: CorpoDeNota): Promise<NotaDaSpedy> {
    return this.pedir("POST", "/v1/service-invoices", corpo).then(lerNota);
  }

  obterNota(id: string): Promise<NotaDaSpedy> {
    return this.pedir("GET", `/v1/service-invoices/${encodeURIComponent(id)}`).then(lerNota);
  }

  /** A nota que já tem esse identificador nosso, ou `null`. */
  async buscarPorIntegrationId(integrationId: string): Promise<NotaDaSpedy | null> {
    const lista = (await this.pedir(
      "GET",
      `/v1/service-invoices?integrationId=${encodeURIComponent(integrationId)}&pageSize=5`,
    )) as { items?: unknown[] } | null;
    const achada = (lista?.items ?? []).map((i) => lerNota(i)).find((n) => n.integrationId === integrationId);
    return achada ?? null;
  }

  private async pedir(metodo: "GET" | "POST", caminho: string, corpo?: unknown): Promise<unknown> {
    let resposta: Response;
    try {
      resposta = await fetch(this.base + caminho, {
        method: metodo,
        headers: {
          "X-Api-Key": this.chave,
          Accept: "application/json",
          ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(PRAZO_MS),
      });
    } catch (erro) {
      throw new SpedyRedeError(erro instanceof Error ? erro.message : String(erro));
    }

    const texto = await resposta.text();
    let json: unknown = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      json = null;
    }
    if (!resposta.ok) {
      throw new SpedyApiError(resposta.status, mensagemDoErro(resposta.status, json, texto), json ?? texto);
    }
    return json;
  }
}

function lerNota(bruto: unknown): NotaDaSpedy {
  const n = (bruto ?? {}) as Record<string, unknown>;
  const detalhe = n.processingDetail as Record<string, unknown> | null | undefined;
  return {
    id: String(n.id ?? ""),
    integrationId: typeof n.integrationId === "string" ? n.integrationId : null,
    status: String(n.status ?? ""),
    number: typeof n.number === "number" && n.number > 0 ? n.number : null,
    processingDetail: detalhe
      ? {
          status: typeof detalhe.status === "string" ? detalhe.status : undefined,
          message: typeof detalhe.message === "string" ? detalhe.message : undefined,
          code: typeof detalhe.code === "string" ? detalhe.code : undefined,
        }
      : null,
  };
}

function mensagemDoErro(status: number, json: unknown, texto: string): string {
  const j = (json ?? {}) as Record<string, unknown>;
  const detalhes = Array.isArray(j.errors) ? j.errors : Array.isArray(j.details) ? j.details : [];
  const partes = [j.message, j.title, j.error, ...detalhes.map((d) => (typeof d === "string" ? d : JSON.stringify(d)))]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  const base = partes.length ? partes.join("; ") : texto.slice(0, 200);
  return `Spedy respondeu ${status}${base ? `: ${base.slice(0, 300)}` : ""}`;
}

/** A chave da empresa no ambiente do servidor, ou `null`. Nunca é registrada em log. */
export function chaveDaSpedy(empresa: string): string | null {
  const valor = process.env[`SPEDY_KEY_${empresa}`]?.trim();
  return valor ? valor : null;
}
