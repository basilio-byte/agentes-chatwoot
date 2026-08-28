import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { limparCacheDeToken } from "./auth";
import { GoogleApiError, GoogleClient } from "./client";
import { URL_DO_TOKEN, lerConfigGoogle, type ChaveDeServico } from "./config";

/**
 * Estes testes travam o **contrato com as três APIs do Google** — Sheets, Docs
 * e Drive: rota, método e, principalmente, os parâmetros de query cuja ausência
 * não dá erro nenhum.
 *
 * É o que separa esta suíte de um teste de cliente HTTP comum. Aqui quase todo
 * defeito volta `200`: `insertDataOption` errado sobrescreve dados,
 * `includeItemsFromAllDrives` faltando devolve lista vazia,
 * `includeTabsContent` faltando lê só a primeira aba. Nenhum deles aparece em
 * produção como falha — aparecem como o agente dizendo uma coisa errada com
 * toda a confiança.
 */

/** Chave real, porque `obterAccessToken` assina de verdade antes de cada chamada. */
let chave: ChaveDeServico;

beforeAll(() => {
  const par = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  chave = {
    type: "service_account",
    project_id: "seahub-teste",
    private_key_id: "kid-da-chave-de-teste",
    private_key: par.privateKey,
    client_email: "agente@seahub-teste.iam.gserviceaccount.com",
  };
});

const TOKEN = "ya29.token-de-teste";

type Chamada = { url: string; method: string; body?: unknown; headers: Headers };

/** Só as chamadas de API — a ida ao endpoint de token fica de fora, senão todo índice viraria conta. */
let chamadas: Chamada[] = [];

/** O assertion que foi trocado por token, para provar que ele não vaza para a API. */
let assertionEnviada = "";

function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Corpo de erro no formato do Google — é de `error.errors[0].reason` que sai o `motivo`. */
function erroDoGoogle(status: number, motivo: string, mensagem = "falhou") {
  return responder(
    {
      error: { code: status, message: mensagem, errors: [{ reason: motivo, message: mensagem }] },
    },
    status,
  );
}

/** Troca o que a API responde, mantendo o endpoint de token sempre funcionando. */
function comRespostas(daApi: (chamada: Chamada, n: number) => Response) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const alvo = String(url);

    if (alvo.startsWith(URL_DO_TOKEN)) {
      assertionEnviada =
        new URLSearchParams(String(init.body ?? "")).get("assertion") ?? "";
      return responder({ access_token: TOKEN, expires_in: 3600 });
    }

    const chamada: Chamada = {
      url: alvo,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init.headers as HeadersInit),
    };
    chamadas.push(chamada);
    return daApi(chamada, chamadas.length);
  });
}

beforeEach(() => {
  chamadas = [];
  assertionEnviada = "";
  // O cache do token é global ao módulo: sem limpar, um caso herdaria o token
  // do anterior e o teste de header passaria por acidente.
  limparCacheDeToken();
  comRespostas(() => responder({}));
});

afterEach(() => vi.unstubAllGlobals());

function cliente(config: Record<string, unknown> = {}): GoogleClient {
  return new GoogleClient(lerConfigGoogle(config), chave);
}

const url = (i = 0) => new URL(chamadas[i].url);
const query = (i = 0) => url(i).searchParams;

/**
 * Roda a operação com o relógio adiantado.
 *
 * O backoff usa `setTimeout` de verdade — 2s já na primeira repetição, que é
 * quase metade do teto padrão de 5s por caso do Vitest. Com relógio falso o
 * teste prova a mesma coisa em milissegundos.
 */
async function comRelogioAdiantado<T>(operacao: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const promessa = operacao();
    // Evita "unhandled rejection" enquanto o relógio anda; o `await` abaixo é
    // quem realmente trata o resultado.
    promessa.catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000);
    return await promessa;
  } finally {
    vi.useRealTimers();
  }
}

/** Espera a falha e devolve o erro tipado, para poder olhar `status` e `motivo`. */
async function capturar(promessa: Promise<unknown>): Promise<GoogleApiError> {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof GoogleApiError) return erro;
    throw erro;
  }
  throw new Error("esperava GoogleApiError, mas a promessa resolveu");
}

describe("autenticação em toda chamada", () => {
  it("manda o access token como Bearer", async () => {
    await cliente().lerDocumento("doc1");

    expect(chamadas[0].headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("⚠ o JWT assinado NUNCA vai como header de API", async () => {
    await cliente().lerDocumento("doc1");

    expect(assertionEnviada.split(".")).toHaveLength(3);

    // O assertion é credencial de TROCA: ele vale por uma hora, carrega os
    // escopos e a identidade da conta, e não é aceito como Bearer. Mandá-lo
    // adiante seria vazar a credencial de assinatura para três hosts diferentes
    // em troca de um 401.
    chamadas[0].headers.forEach((valor) => {
      expect(valor).not.toContain(assertionEnviada);
    });
  });
});

describe("Sheets: escrita", () => {
  /**
   * ⚠ O teste mais importante do arquivo.
   *
   * A referência da API documenta os dois valores de `insertDataOption` e **não
   * documenta o padrão**. Com `OVERWRITE`, uma aba que tenha qualquer coisa
   * abaixo da tabela — totais, rodapé, uma segunda tabela — é gravada por cima,
   * e a resposta volta `200` com `updatedCells` correto. Perda de dados
   * silenciosa, num sistema que não tem tool de exclusão nem desfazer.
   */
  it("acrescentarLinha manda valueInputOption=RAW E insertDataOption=INSERT_ROWS", async () => {
    await cliente().acrescentarLinha("plan1", "Clientes", ["Ana", "01234567890"], "B");

    expect(query().get("insertDataOption")).toBe("INSERT_ROWS");
    // `RAW` é a outra metade: `USER_ENTERED` come o zero à esquerda do CPF,
    // reinterpreta data pelo locale da planilha e transforma um texto que
    // começa com `=` em FÓRMULA — texto vindo de cliente virando fórmula numa
    // planilha corporativa é exfiltração de dados.
    expect(query().get("valueInputOption")).toBe("RAW");
  });

  it("acrescentarLinha é POST em :append, com a aba entre aspas simples", async () => {
    await cliente().acrescentarLinha("plan1", "Base 2026", ["x"], "A");

    expect(chamadas[0].method).toBe("POST");
    // ⚠ As aspas não são enfeite: uma aba chamada `2026` ou `A1` sem aspas é
    // lida como CÉLULA, e a linha iria parar em outro lugar.
    expect(decodeURIComponent(url().pathname)).toBe(
      "/v4/spreadsheets/plan1/values/'Base 2026'!A:A:append",
    );
    expect(chamadas[0].body).toEqual({ values: [["x"]] });
  });

  it("atualizarCelulas escreve célula a célula, também em RAW", async () => {
    await cliente().atualizarCelulas("plan1", [
      { range: "'Clientes'!C7", values: [["novo"]] },
    ]);

    expect(chamadas[0].method).toBe("POST");
    expect(url().pathname).toBe("/v4/spreadsheets/plan1/values:batchUpdate");
    // Uma faixa por célula, e nunca a linha inteira: mandar a linha apagaria as
    // colunas que o agente não informou.
    expect(chamadas[0].body).toEqual({
      valueInputOption: "RAW",
      data: [{ range: "'Clientes'!C7", values: [["novo"]] }],
    });
  });
});

describe("Sheets: leitura", () => {
  it("⚠ lerValores manda os DOIS parâmetros de renderização", async () => {
    await cliente().lerValores("plan1", "'Clientes'!A1:F50");

    expect(query().get("valueRenderOption")).toBe("UNFORMATTED_VALUE");
    // Sozinho, `UNFORMATTED_VALUE` deixa `dateTimeRenderOption` no padrão
    // `SERIAL_NUMBER`, e TODA data vira um inteiro de cinco dígitos que o
    // modelo repassa ao cliente como se fosse a data.
    expect(query().get("dateTimeRenderOption")).toBe("FORMATTED_STRING");
    expect(decodeURIComponent(url().pathname)).toBe(
      "/v4/spreadsheets/plan1/values/'Clientes'!A1:F50",
    );
  });

  it("majorDimension=COLUMNS só quando a leitura é por coluna", async () => {
    const c = cliente();
    await c.lerValores("plan1", "'Clientes'!A2:A");
    await c.lerValores("plan1", "'Clientes'!A2:A", { porColuna: true });

    // Sem `COLUMNS`, ler uma coluna devolve mil arrays de um elemento e o
    // `[0]` de quem chama pega só a primeira célula.
    expect(query(0).get("majorDimension")).toBeNull();
    expect(query(1).get("majorDimension")).toBe("COLUMNS");
  });

  it("estruturaDaPlanilha não traz a grade", async () => {
    await cliente().estruturaDaPlanilha("plan1");

    expect(query().get("includeGridData")).toBe("false");
    // O `fields` é a outra trava: sem ele, a resposta vem com a planilha
    // inteira — megabytes para exibir três nomes de aba.
    const fields = query().get("fields") ?? "";
    expect(fields).toContain("sheets.properties");
    expect(fields).not.toContain("gridData");
  });
});

describe("Docs", () => {
  it("⚠ lerDocumento pede o conteúdo das abas", async () => {
    await cliente().lerDocumento("doc1");

    expect(url().host).toBe("docs.googleapis.com");
    expect(url().pathname).toBe("/v1/documents/doc1");
    // Sem isto, um documento organizado por abas devolve SÓ a primeira, sem
    // erro nenhum — e ninguém desconfia, porque o texto que volta é válido.
    expect(query().get("includeTabsContent")).toBe("true");
  });

  it("atualizarDocumento é batchUpdate com os requests no corpo", async () => {
    await cliente().atualizarDocumento("doc1", [{ insertText: { text: "oi" } }]);

    expect(chamadas[0].method).toBe("POST");
    expect(url().pathname).toBe("/v1/documents/doc1:batchUpdate");
    expect(chamadas[0].body).toEqual({ requests: [{ insertText: { text: "oi" } }] });
  });
});

describe("Drive", () => {
  it("⚠ listarArquivos manda os DOIS parâmetros de drive compartilhado", async () => {
    await cliente().listarArquivos("'pasta1' in parents", 50);

    expect(query().get("supportsAllDrives")).toBe("true");
    // `supportsAllDrives` sozinho devolve `200` com `files: []` numa pasta que
    // está cheia. Silêncio, não erro — e o agente conclui que a pasta é vazia.
    expect(query().get("includeItemsFromAllDrives")).toBe("true");
  });

  it("⚠ o fields da listagem inclui nextPageToken", async () => {
    await cliente().listarArquivos("'pasta1' in parents", 50);

    // `files(...)` sem `nextPageToken` mata a paginação na primeira página,
    // também em silêncio: quem chama nunca sabe que havia mais, e diz ao
    // cliente que a pasta só tem aquilo.
    expect(query().get("fields")).toContain("nextPageToken");
    expect(query().get("fields")).toContain("webViewLink");
    expect(query().get("q")).toBe("'pasta1' in parents");
  });

  it("⚠ corpora e driveId NUNCA são mandados, nem com Drive compartilhado configurado", async () => {
    await cliente().listarArquivos("q1", 50);
    await cliente({ driveCompartilhadoId: "drive-da-seahub" }).listarArquivos("q1", 50);

    // `corpora=drive` restringe a busca aos itens DAQUELE Drive compartilhado,
    // e `driveCompartilhadoId` existe para dizer onde CRIAR arquivo, não onde
    // procurar. Mandá-lo fazia uma pasta do Meu Drive de alguém — o caminho
    // normal, compartilhada com a conta de serviço — passar a devolver lista
    // vazia no dia em que o operador preenchesse o Drive compartilhado para
    // poder gerar documento. `200`, sem erro, sem rastro.
    for (const i of [0, 1]) {
      expect(query(i).get("corpora")).toBeNull();
      expect(query(i).get("driveId")).toBeNull();
      // Os dois que realmente alcançam os dois mundos.
      expect(query(i).get("supportsAllDrives")).toBe("true");
      expect(query(i).get("includeItemsFromAllDrives")).toBe("true");
    }
  });

  it("copiarArquivo é POST em /copy, com a pasta de destino no corpo", async () => {
    await cliente().copiarArquivo("modelo1", "Contrato da Ana", "pasta1");

    expect(chamadas[0].method).toBe("POST");
    expect(url().pathname).toBe("/drive/v3/files/modelo1/copy");
    // Sem `supportsAllDrives`, copiar para dentro de um Drive compartilhado
    // falha — e é o único destino possível, porque a conta de serviço não pode
    // ser dona de arquivo.
    expect(query().get("supportsAllDrives")).toBe("true");
    // `parents` vai no CORPO. Como query ele é ignorado em silêncio e o arquivo
    // nasce na raiz.
    expect(chamadas[0].body).toEqual({
      name: "Contrato da Ana",
      parents: ["pasta1"],
    });
  });
});

describe("erros traduzidos", () => {
  it("⚠ 404 fala do compartilhamento, não só do id", async () => {
    comRespostas(() => erroDoGoogle(404, "notFound", "File not found: plan1."));

    const erro = await capturar(cliente().estruturaDaPlanilha("plan1"));

    expect(erro.status).toBe(404);
    // O Google responde a mesma coisa para arquivo inexistente e para arquivo
    // que existe e não foi compartilhado — de propósito, para não vazar a
    // existência dele. Repassado cru, o modelo diz que "essa planilha não
    // existe" e o operador vai caçar um id que está certo.
    expect(erro.message).toContain(chave.client_email);
    expect(erro.message).toContain("compartilhado");
  });

  it("403 storageQuotaExceeded explica que só CRIAR é que não dá", async () => {
    comRespostas(() => erroDoGoogle(403, "storageQuotaExceeded"));

    const erro = await capturar(cliente().copiarArquivo("modelo1", "Novo", "pasta1"));

    expect(erro.message).toContain("Drive compartilhado");
    // A segunda metade é o que evita o pânico: quem lê "quota excedida" desliga
    // a integração inteira, quando escrever no que já existe continua
    // funcionando normalmente.
    expect(erro.message).toContain("já existe");
  });
});

describe("política de repetição", () => {
  /**
   * A assimetria aqui é decisão de segurança, não de desempenho.
   *
   * `429` é recusa definitiva: o Google não executou nada, e repetir é seguro
   * sempre. Já `5xx` é ambíguo — a escrita pode ter sido aplicada antes do erro
   * voltar, e a Sheets **não tem idempotência** (sem ETag, sem `If-Match`, sem
   * chave de requisição). Repetir um `append` nesse caso grava a linha duas
   * vezes, e não existe desfazer.
   */
  it("403 de cota é repetido numa leitura", async () => {
    comRespostas((_, n) =>
      n === 1 ? erroDoGoogle(403, "rateLimitExceeded") : responder({ values: [["ok"]] }),
    );

    const r = await comRelogioAdiantado(() => cliente().lerValores("plan1", "A1"));

    // Desistir de um pico de tráfego que passaria sozinho é perder o
    // atendimento por causa de um segundo.
    expect(chamadas).toHaveLength(2);
    expect(r.values).toEqual([["ok"]]);
  });

  it("403 de permissão NÃO é repetido", async () => {
    comRespostas(() => erroDoGoogle(403, "insufficientFilePermissions"));

    await capturar(cliente().lerValores("plan1", "A1"));

    // Martelar uma permissão que falta só gasta o tempo do cliente até o
    // timeout — o vigia escala a conversa em 3 minutos.
    expect(chamadas).toHaveLength(1);
  });

  it("429 é repetido, inclusive numa escrita", async () => {
    comRespostas((_, n) =>
      n === 1 ? erroDoGoogle(429, "rateLimitExceeded") : responder({ updates: {} }),
    );

    await comRelogioAdiantado(() =>
      cliente().acrescentarLinha("plan1", "Clientes", ["x"], "A"),
    );

    // Seguro porque `429` é recusa ANTES de executar: não há linha gravada para
    // duplicar.
    expect(chamadas).toHaveLength(2);
  });

  it("500 numa leitura é repetido", async () => {
    comRespostas((_, n) =>
      n === 1 ? erroDoGoogle(500, "backendError") : responder({ values: [] }),
    );

    await comRelogioAdiantado(() => cliente().estruturaDaPlanilha("plan1"));

    expect(chamadas).toHaveLength(2);
  });

  it("⚠ 500 num acrescentarLinha NÃO é repetido", async () => {
    comRespostas(() => erroDoGoogle(500, "backendError"));

    await capturar(cliente().acrescentarLinha("plan1", "Clientes", ["x"], "A"));

    // Uma tentativa só. A segunda gravaria a mesma linha de novo se a primeira
    // tivesse sido aplicada antes do erro — e ninguém descobriria até alguém
    // abrir a planilha semanas depois.
    expect(chamadas).toHaveLength(1);
  });

  it("500 numa atualização de célula também não é repetido", async () => {
    comRespostas(() => erroDoGoogle(500, "backendError"));

    await capturar(
      cliente().atualizarCelulas("plan1", [{ range: "'A'!B2", values: [["x"]] }]),
    );

    expect(chamadas).toHaveLength(1);
  });
});
