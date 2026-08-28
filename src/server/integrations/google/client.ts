import { obterAccessToken } from "./auth";
import { ESCOPOS, type ChaveDeServico, type GoogleConfig } from "./config";
import { a1 } from "./sheets";

/**
 * Cliente das três APIs do Google — Sheets, Docs e Drive.
 *
 * Uma classe só, e não três, porque o que muda entre elas é o host e o caminho;
 * autenticação, backoff e tradução de erro são idênticos. Três classes
 * triplicariam o cache de access token, que é justamente o que não pode ser
 * triplicado no caminho quente.
 */

const HOSTS = {
  sheets: "https://sheets.googleapis.com",
  docs: "https://docs.googleapis.com",
  drive: "https://www.googleapis.com",
} as const;

type Host = keyof typeof HOSTS;

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    /** `reason` do primeiro erro do corpo — é ele que separa cota de permissão. */
    readonly motivo: string,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "GoogleApiError";
  }
}

/**
 * `403` no Google é cota tanto quanto permissão, e só o `reason` separa.
 *
 * ⚠ Tratar todo `403` como fatal faz desistir de um pico de tráfego que passaria
 * sozinho; tratar todo `403` como retentável faz martelar um
 * `insufficientFilePermissions` até o timeout, com o cliente esperando.
 */
const MOTIVOS_RETENTAVEIS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "backendError",
  "internalError",
]);

const MAX_TENTATIVAS = 3;

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GoogleClient {
  constructor(
    private readonly config: GoogleConfig,
    private readonly chave: ChaveDeServico,
  ) {}

  get contaEmail(): string {
    return this.chave.client_email;
  }

  private async requisitar<T>(
    host: Host,
    caminho: string,
    opcoes: {
      method?: string;
      corpo?: unknown;
      query?: Record<string, unknown>;
      /**
       * A operação pode ser repetida sem efeito colateral.
       *
       * ⚠ Decide o backoff, e é uma decisão de segurança, não de desempenho.
       * `429` é recusa definitiva — o Google não executou nada, e repetir é
       * seguro sempre. Já `5xx` é ambíguo: a escrita pode ter sido aplicada
       * antes de o erro voltar. Repetir um `append` nesse caso grava a linha
       * duas vezes, e a Sheets **não tem idempotência** (sem ETag, sem
       * `If-Match`, sem chave de requisição). Por isso escrita só repete em
       * `429`.
       */
      idempotente?: boolean;
    } = {},
  ): Promise<T> {
    const token = await obterAccessToken(
      this.chave,
      ESCOPOS,
      this.config.personificar || undefined,
    );

    const url = new URL(`${HOSTS[host]}${caminho}`);
    for (const [chave, valor] of Object.entries(opcoes.query ?? {})) {
      if (valor === undefined || valor === null || valor === "") continue;
      url.searchParams.set(chave, String(valor));
    }

    let ultimoErro: unknown;

    for (let tentativa = 0; tentativa < MAX_TENTATIVAS; tentativa++) {
      if (tentativa > 0) {
        // Backoff exponencial truncado com ruído, como a documentação do Google
        // exige — sem o ruído, quatro conversas simultâneas voltam juntas e
        // reproduzem o mesmo 429.
        await esperar(Math.min(2 ** tentativa * 1000 + Math.random() * 500, 16_000));
      }

      let resposta: Response;
      try {
        resposta = await fetch(url.toString(), {
          method: opcoes.method ?? "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            ...(opcoes.corpo !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
          },
          ...(opcoes.corpo !== undefined
            ? { body: JSON.stringify(opcoes.corpo) }
            : {}),
          // Curto de propósito: o vigia de espera escala a conversa para uma
          // pessoa em 3 minutos, e uma tool pendurada faz a resposta do agente
          // ser descartada quando ele finalmente terminar.
          signal: AbortSignal.timeout(30_000),
        });
      } catch (erro) {
        ultimoErro = erro;
        // Falha de rede antes de resposta: para leitura vale insistir; para
        // escrita não dá para saber se o servidor recebeu.
        if (opcoes.idempotente) continue;
        throw erro;
      }

      if (resposta.ok) {
        if (resposta.status === 204) return undefined as T;
        return (await resposta.json()) as T;
      }

      const erro = await this.lerErro(resposta);
      ultimoErro = erro;

      const vaiRepetir =
        (resposta.status === 429 ||
          (opcoes.idempotente &&
            (resposta.status >= 500 ||
              (resposta.status === 403 && MOTIVOS_RETENTAVEIS.has(erro.motivo))))) &&
        tentativa < MAX_TENTATIVAS - 1;

      if (!vaiRepetir) throw erro;
    }

    throw ultimoErro;
  }

  /** Extrai `reason` e traduz as mensagens que enganam o operador. */
  private async lerErro(resposta: Response): Promise<GoogleApiError> {
    const bruto = await resposta.text().catch(() => "");
    let motivo = "";
    let mensagem = "";

    try {
      const corpo = JSON.parse(bruto) as {
        error?: {
          message?: string;
          errors?: { reason?: string; message?: string }[];
        };
      };
      motivo = corpo.error?.errors?.[0]?.reason ?? "";
      mensagem = corpo.error?.message ?? "";
    } catch {
      mensagem = bruto.slice(0, 300);
    }

    return new GoogleApiError(
      resposta.status,
      motivo,
      this.traduzir(resposta.status, motivo, mensagem),
    );
  }

  /**
   * Traduz o erro para algo que o modelo possa repetir sem mentir.
   *
   * ⚠ O caso que mais importa é o `404`. O Google devolve "File not found" tanto
   * para arquivo inexistente quanto para arquivo que existe e **não foi
   * compartilhado** — é de propósito, para não vazar a existência do arquivo.
   * Repassado cru, o modelo diz ao cliente que "essa planilha não existe", e o
   * operador vai procurar um id errado que está certo. A tradução tem de citar
   * o e-mail da conta de serviço, que é a coisa que falta ser feita.
   */
  private traduzir(status: number, motivo: string, mensagem: string): string {
    if (status === 404) {
      return `O Google não encontrou o arquivo. Ou o id cadastrado está errado, ou o arquivo não foi compartilhado com a conta de serviço ${this.chave.client_email} — o Google responde a mesma coisa nos dois casos, de propósito. Confira o compartilhamento antes de mudar o id.`;
    }

    if (status === 403 && motivo === "storageQuotaExceeded") {
      return "Não dá para CRIAR arquivo com esta conta: uma conta de serviço tem quota de armazenamento zero e não pode ser dona de arquivo nenhum. Só criar dentro de um Drive compartilhado resolve — cadastre o id dele na configuração da integração. Escrever em arquivo que já existe continua funcionando normalmente.";
    }

    if (status === 403 && motivo === "appNotAuthorizedToFile") {
      return "A conta de serviço não tem acesso a este arquivo por este escopo. Confira se as APIs do Drive, Sheets e Docs estão ativadas no projeto do Google Cloud.";
    }

    if (status === 403 && motivo === "accessNotConfigured") {
      return `A API necessária não está ativada no projeto ${this.chave.project_id} do Google Cloud. Ative Google Drive API, Google Sheets API e Google Docs API em APIs & Services → Library.`;
    }

    if (status === 403) {
      return `O Google recusou o acesso (403${motivo ? `, ${motivo}` : ""}): ${
        mensagem || "sem detalhe"
      }. Normalmente é falta de permissão de EDITOR para ${
        this.chave.client_email
      } no arquivo.`;
    }

    if (status === 429) {
      return "O Google recusou por excesso de requisições (429). Tente de novo em alguns segundos.";
    }

    return `O Google respondeu ${status}${motivo ? ` (${motivo})` : ""}: ${
      mensagem || "sem detalhe"
    }`;
  }

  // ─── Sheets ───────────────────────────────────────────────────────────────

  async estruturaDaPlanilha(planilhaId: string): Promise<{
    properties?: { title?: string };
    sheets?: {
      properties?: {
        title?: string;
        gridProperties?: { rowCount?: number; columnCount?: number };
      };
    }[];
  }> {
    return this.requisitar("sheets", `/v4/spreadsheets/${planilhaId}`, {
      // Sem `fields`, a resposta traz a grade inteira e pesa megabytes numa
      // planilha grande — para exibir três nomes de aba.
      query: {
        includeGridData: "false",
        fields:
          "properties.title,sheets.properties(title,gridProperties(rowCount,columnCount))",
      },
      idempotente: true,
    });
  }

  async lerValores(
    planilhaId: string,
    intervalo: string,
    opcoes: { porColuna?: boolean } = {},
  ): Promise<{ values?: unknown[][] }> {
    return this.requisitar(
      "sheets",
      `/v4/spreadsheets/${planilhaId}/values/${encodeURIComponent(intervalo)}`,
      {
        query: {
          // ⚠ Os dois andam juntos. `UNFORMATTED_VALUE` sozinho deixa
          // `dateTimeRenderOption` no padrão `SERIAL_NUMBER`, e TODA data vira
          // um inteiro de cinco dígitos que o modelo repassa ao cliente.
          valueRenderOption: "UNFORMATTED_VALUE",
          dateTimeRenderOption: "FORMATTED_STRING",
          ...(opcoes.porColuna ? { majorDimension: "COLUMNS" } : {}),
        },
        idempotente: true,
      },
    );
  }

  /**
   * Acrescenta uma linha ao fim da tabela de uma aba.
   *
   * ⚠ **`insertDataOption: "INSERT_ROWS"` é obrigatório e explícito.** A
   * referência da API documenta os dois valores e **não documenta qual é o
   * padrão**. Com `OVERWRITE`, uma aba que tenha qualquer coisa abaixo da
   * tabela — uma linha de totais, um rodapé, uma segunda tabela — é gravada por
   * cima, e a resposta volta `200` com `updatedCells` correto. Perda de dados
   * silenciosa, sem desfazer.
   *
   * ⚠ **`valueInputOption: "RAW"`, sempre.** `USER_ENTERED` interpreta o texto
   * como se alguém tivesse digitado: `01234567890` vira o número
   * `1234567890` e o zero do CPF some, `28/08/2026` vira data conforme o
   * `locale` da planilha (que um humano pode mudar), e um valor começando com
   * `=` vira FÓRMULA — texto vindo de cliente executando fórmula numa planilha
   * corporativa é exfiltração de dados. A formatação visual (R$, dd/mm/aaaa) é
   * atributo da coluna, definido uma vez na planilha.
   */
  async acrescentarLinha(
    planilhaId: string,
    aba: string,
    linha: string[],
    /**
     * Última coluna do cabeçalho, ex.: `"F"`.
     *
     * ⚠ Ancorar a faixa em `A:<F>` e não mandar a aba inteira. O `range` do
     * append é onde PROCURAR a tabela, e a escrita começa na primeira coluna da
     * tabela **detectada** — não na coluna A. Uma planilha cujo cabeçalho
     * comece em `B1` (coluna A deixada vazia por estética) faz a tabela ser
     * detectada a partir de B, e a linha inteira sai deslocada uma casa: o
     * último valor cai fora do cabeçalho, com `200` e `gravado: true`.
     */
    ultimaColuna: string,
  ): Promise<{ updates?: { updatedRange?: string } }> {
    return this.requisitar(
      "sheets",
      `/v4/spreadsheets/${planilhaId}/values/${encodeURIComponent(
        a1(aba, `A:${ultimaColuna}`),
      )}:append`,
      {
        method: "POST",
        query: {
          valueInputOption: "RAW",
          insertDataOption: "INSERT_ROWS",
          // Devolve onde caiu de verdade, para o retorno da tool não ter de
          // supor. O `range` do append é onde PROCURAR a tabela, não onde
          // escrever — os dois quase nunca coincidem.
          includeValuesInResponse: "false",
        },
        corpo: { values: [linha] },
      },
    );
  }

  /** Escreve célula a célula — nunca a linha inteira, que apagaria o resto. */
  async atualizarCelulas(
    planilhaId: string,
    dados: { range: string; values: string[][] }[],
  ): Promise<{ totalUpdatedCells?: number }> {
    return this.requisitar(
      "sheets",
      `/v4/spreadsheets/${planilhaId}/values:batchUpdate`,
      {
        method: "POST",
        corpo: { valueInputOption: "RAW", data: dados },
      },
    );
  }

  // ─── Docs ─────────────────────────────────────────────────────────────────

  async lerDocumento(documentoId: string): Promise<DocumentoGoogle> {
    return this.requisitar("docs", `/v1/documents/${documentoId}`, {
      // ⚠ Sem isto, um documento com abas devolve SÓ a primeira, sem erro
      // nenhum — e ninguém desconfia, porque o texto que volta é válido.
      query: { includeTabsContent: "true" },
      idempotente: true,
    });
  }

  async atualizarDocumento(
    documentoId: string,
    requests: unknown[],
  ): Promise<{ replies?: { replaceAllText?: { occurrencesChanged?: number } }[] }> {
    return this.requisitar("docs", `/v1/documents/${documentoId}:batchUpdate`, {
      method: "POST",
      corpo: { requests },
    });
  }

  // ─── Drive ────────────────────────────────────────────────────────────────

  /**
   * Parâmetros de Drive compartilhado.
   *
   * ⚠ `supportsAllDrives` sozinho **não** basta na listagem: sem
   * `includeItemsFromAllDrives`, a busca devolve `200` com `files: []`. Silêncio,
   * não erro — e o agente conclui que a pasta está vazia.
   *
   * ⚠ **E `corpora`/`driveId` NÃO entram aqui**, por mais que o
   * `driveCompartilhadoId` esteja configurado. `corpora=drive` restringe a
   * consulta aos itens **daquele** Drive compartilhado, e o campo existe para
   * dizer onde CRIAR arquivo, não onde procurar. Mandá-lo fazia uma pasta do
   * Meu Drive de alguém — o caminho normal, compartilhado com a conta de
   * serviço — passar a devolver lista vazia no dia em que o operador
   * preenchesse o Drive compartilhado para poder gerar documento. `200`, sem
   * erro, sem rastro: exatamente o desfecho que os dois parâmetros acima
   * existem para evitar. Os dois juntos já alcançam os dois mundos.
   */
  private paramsDeDrive(listagem: boolean): Record<string, unknown> {
    const base: Record<string, unknown> = { supportsAllDrives: "true" };
    if (listagem) base.includeItemsFromAllDrives = "true";
    return base;
  }

  async listarArquivos(
    q: string,
    limite: number,
  ): Promise<{ files?: ArquivoDrive[]; nextPageToken?: string }> {
    return this.requisitar("drive", "/drive/v3/files", {
      query: {
        q,
        pageSize: Math.min(limite, 1000),
        // ⚠ Sem `fields`, a resposta traz só `kind,id,name,mimeType` — nada de
        // tamanho, data ou link. E `files(...)` SEM `nextPageToken` mata a
        // paginação na primeira página, também em silêncio.
        fields:
          "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)",
        orderBy: "folder,name",
        ...this.paramsDeDrive(true),
      },
      idempotente: true,
    });
  }

  async copiarArquivo(
    arquivoId: string,
    nome: string,
    pastaId?: string,
  ): Promise<ArquivoDrive> {
    return this.requisitar("drive", `/drive/v3/files/${arquivoId}/copy`, {
      method: "POST",
      query: {
        fields: "id,name,mimeType,webViewLink",
        ...this.paramsDeDrive(false),
      },
      corpo: {
        name: nome,
        ...(pastaId ? { parents: [pastaId] } : {}),
      },
    });
  }

  /**
   * Ping da configuração.
   *
   * Não usa um endpoint amplo de propósito: `drive/v3/about` responde para
   * qualquer chave válida e diria "funcionou" para uma conta que não enxerga
   * nenhuma planilha cadastrada — que é o estado mais comum e mais confuso de
   * todos, porque parece configuração pronta.
   */
  async testar(): Promise<{
    ok: boolean;
    mensagem: string;
    indeterminado?: boolean;
  }> {
    try {
      await obterAccessToken(
        this.chave,
        ESCOPOS,
        this.config.personificar || undefined,
      );
    } catch (erro) {
      return {
        ok: false,
        mensagem: erro instanceof Error ? erro.message : "Falha desconhecida.",
      };
    }

    const primeira = this.config.planilhas[0] ?? this.config.documentos[0];

    if (!primeira) {
      return {
        ok: true,
        indeterminado: true,
        mensagem: `A chave funciona e o Google devolveu um token para ${this.chave.client_email}. Não dá para confirmar mais do que isso ainda: cadastre pelo menos uma planilha ou documento e teste de novo — é o compartilhamento de cada arquivo que costuma faltar, não a chave.`,
      };
    }

    try {
      const alvo = this.config.planilhas[0];
      if (alvo) {
        const estrutura = await this.estruturaDaPlanilha(alvo.id);
        const abas = (estrutura.sheets ?? [])
          .map((s) => s.properties?.title)
          .filter(Boolean);
        return {
          ok: true,
          mensagem: `Conexão bem-sucedida como ${this.chave.client_email}. Li a planilha "${alvo.nome}" (${abas.length} aba(s): ${abas.join(", ")}).`,
        };
      }

      const doc = await this.lerDocumento(primeira.id);
      return {
        ok: true,
        mensagem: `Conexão bem-sucedida como ${this.chave.client_email}. Li o documento "${doc.title ?? primeira.nome}".`,
      };
    } catch (erro) {
      return {
        ok: false,
        mensagem: `A chave funciona, mas não consegui abrir "${primeira.nome}": ${
          erro instanceof Error ? erro.message : "falha desconhecida"
        }`,
      };
    }
  }
}

export type ArquivoDrive = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
};

export type ElementoDoDoc = {
  paragraph?: {
    elements?: { textRun?: { content?: string } }[];
  };
  table?: {
    tableRows?: {
      tableCells?: { content?: ElementoDoDoc[] }[];
    }[];
  };
  tableOfContents?: { content?: ElementoDoDoc[] };
};

export type AbaDoDoc = {
  documentTab?: { body?: { content?: ElementoDoDoc[] } };
  childTabs?: AbaDoDoc[];
};

export type DocumentoGoogle = {
  title?: string;
  body?: { content?: ElementoDoDoc[] };
  tabs?: AbaDoDoc[];
};
