/**
 * Cliente da NotificaMe (WhatsApp OFICIAL), escrito à mão como o da Spedy, o do
 * Conexa e o da ZapSign: `fetch` e nada mais.
 *
 * - **Token no cabeçalho `X-Api-Token`.** Vem de `IntegrationCredential`
 *   (cifrado), nunca do código nem da tela de leitura.
 * - ⚠ **Mandar template é irreversível**: a mensagem vai ao celular do cliente e
 *   não há como desfazer. Por isso a falha tem DOIS sentidos, e quem chama
 *   precisa separá-los:
 *   - `NotificaMeApiError` com 4xx (menos 408 e 429): a NotificaMe RECUSOU, nada
 *     saiu, e repetir igual dá no mesmo;
 *   - `NotificaMeRedeError`, 5xx, 408 e 429: não se sabe se saiu. Quem repete às
 *     cegas manda a mesma mensagem duas vezes — o defeito que trouxe este módulo
 *     (o fluxo do n8n mandou o template três vezes ao mesmo cliente).
 * - Sem repetição automática, de propósito, pelo mesmo motivo.
 * - Só o que o envio do template usa: mandar e ler a lista de templates do canal
 *   (para a nota mostrar o texto REAL que o cliente recebeu e para o botão de
 *   teste conferir token, canal e template).
 */

const BASE_PADRAO = "https://api.notificame.com.br";
const PRAZO_MS = 20_000;

export class NotificaMeApiError extends Error {
  constructor(
    readonly status: number,
    mensagem: string,
    readonly corpo?: unknown,
  ) {
    super(mensagem);
    this.name = "NotificaMeApiError";
  }
}

/** A chamada não chegou a ter resposta: pode ou não ter sido aplicada. */
export class NotificaMeRedeError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "NotificaMeRedeError";
  }
}

/**
 * A NotificaMe RECUSOU o pedido (dado inválido, token errado, template que não
 * existe): nada saiu e repetir igual dá no mesmo. 408 e 429 são "tente depois",
 * e 5xx é incerto — nesses a mensagem PODE ter saído.
 */
export function ehRecusaDefinitiva(erro: unknown): erro is NotificaMeApiError {
  return (
    erro instanceof NotificaMeApiError &&
    erro.status >= 400 &&
    erro.status < 500 &&
    erro.status !== 408 &&
    erro.status !== 429
  );
}

/** Não dá para dizer se a mensagem saiu: rede, prazo, 5xx, 408 ou 429. */
export function ehIncerto(erro: unknown): boolean {
  return (
    erro instanceof NotificaMeRedeError ||
    (erro instanceof NotificaMeApiError && !ehRecusaDefinitiva(erro))
  );
}

export type TemplateDaNotificaMe = {
  nome: string;
  idioma: string | null;
  /** `APPROVED`, `PENDING`, `REJECTED`… Só `APPROVED` pode ser enviado. */
  status: string | null;
  categoria: string | null;
  /** O texto do corpo, com os `{{parametros}}` ainda dentro. */
  corpo: string | null;
};

export type EnvioDeTemplate = {
  canalId: string;
  /** Só dígitos, com o código do país (`558499999999`). */
  para: string;
  template: string;
  idioma: string;
  parametros: Array<{ nome: string; texto: string }>;
};

export class NotificaMeClient {
  constructor(
    private readonly token: string,
    private readonly base: string = process.env.NOTIFICAME_BASE_URL ?? BASE_PADRAO,
  ) {}

  /**
   * Manda o template. O corpo é o que o fluxo do n8n já mandava e a NotificaMe já
   * aceitava em produção: parâmetro NOMEADO no corpo (`BODY`), idioma por código.
   * Devolve o id que a NotificaMe deu à mensagem (`queued` quer dizer aceita para
   * entrega, não entregue).
   */
  async enviarTemplate(envio: EnvioDeTemplate): Promise<{ id: string | null; status: string | null }> {
    const resposta = (await this.pedir("POST", "/v2/channels/whatsapp/messages", {
      from: envio.canalId,
      to: envio.para,
      contents: [
        {
          type: "template",
          template: {
            name: envio.template,
            components: [
              {
                type: "BODY",
                parameters: envio.parametros.map((p) => ({
                  type: "text",
                  parameter_name: p.nome,
                  text: p.texto,
                })),
              },
            ],
            language: { code: envio.idioma },
          },
        },
      ],
    })) as Record<string, unknown> | null;

    return {
      id: typeof resposta?.id === "string" ? resposta.id : null,
      status: typeof resposta?.status === "string" ? resposta.status : null,
    };
  }

  /** Os templates do canal. Lista vazia se a resposta vier num formato que não conhecemos. */
  async listarTemplates(canalId: string): Promise<TemplateDaNotificaMe[]> {
    const dados = (await this.pedir("GET", `/v1/templates/${encodeURIComponent(canalId)}`)) as
      | { data?: unknown }
      | unknown[]
      | null;
    const lista = Array.isArray(dados) ? dados : Array.isArray(dados?.data) ? dados.data : [];

    return lista.flatMap((bruto) => {
      const t = (bruto ?? {}) as Record<string, unknown>;
      if (typeof t.name !== "string") return [];
      const componentes = Array.isArray(t.components) ? (t.components as Array<Record<string, unknown>>) : [];
      const corpo = componentes.find((c) => c?.type === "BODY" && typeof c.text === "string");
      return [
        {
          nome: t.name,
          idioma: typeof t.language === "string" ? t.language : null,
          status: typeof t.status === "string" ? t.status : null,
          categoria: typeof t.category === "string" ? t.category : null,
          corpo: corpo ? String(corpo.text) : null,
        },
      ];
    });
  }

  private async pedir(metodo: "GET" | "POST", caminho: string, corpo?: unknown): Promise<unknown> {
    let resposta: Response;
    try {
      resposta = await fetch(this.base + caminho, {
        method: metodo,
        headers: {
          "X-Api-Token": this.token,
          Accept: "application/json",
          ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(PRAZO_MS),
      });
    } catch (erro) {
      throw new NotificaMeRedeError(erro instanceof Error ? erro.message : String(erro));
    }

    const texto = await resposta.text();
    let json: unknown = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      json = null;
    }
    if (!resposta.ok) {
      throw new NotificaMeApiError(resposta.status, mensagemDoErro(resposta.status, json, texto), json ?? texto);
    }
    return json;
  }
}

function mensagemDoErro(status: number, json: unknown, texto: string): string {
  const j = (json ?? {}) as Record<string, unknown>;
  const aninhado = (j.error ?? {}) as Record<string, unknown>;
  const partes = [j.message, j.title, typeof j.error === "string" ? j.error : null, aninhado.message, j.detail]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  const base = partes.length ? partes.join("; ") : texto.slice(0, 200);
  return `NotificaMe respondeu ${status}${base ? `: ${base.slice(0, 300)}` : ""}`;
}
