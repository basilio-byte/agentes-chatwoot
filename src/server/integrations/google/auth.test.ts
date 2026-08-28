import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GoogleAuthError,
  limparCacheDeToken,
  montarAssertion,
  obterAccessToken,
} from "./auth";
import { URL_DO_TOKEN, type ChaveDeServico } from "./config";

/**
 * Estes testes travam o **contrato do fluxo JWT Bearer** com o Google: o que
 * vai dentro do assertion, para onde ele é postado e o que o cache pode e não
 * pode devolver.
 *
 * O motivo de existirem é que quase toda falha aqui é silenciosa do jeito
 * errado: um `aud` errado ou um `exp` grande demais voltam como
 * `invalid_grant`, que aponta para a chave e manda o operador rotacionar uma
 * credencial que está boa; e um cache com chave incompleta devolve o token de
 * OUTRO usuário sem erro nenhum.
 */

/**
 * Par RSA de verdade, gerado uma vez.
 *
 * ⚠ Chave de mentira não serve: `montarAssertion` assina com `node:crypto`, que
 * recusa qualquer coisa que não seja uma PKCS#8 válida. E gerar por caso de
 * teste custaria centenas de milissegundos por `it`.
 */
let chave: ChaveDeServico;
let chavePublica: string;

beforeAll(() => {
  const par = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  chavePublica = par.publicKey;
  chave = {
    type: "service_account",
    project_id: "seahub-teste",
    private_key_id: "kid-da-chave-de-teste",
    private_key: par.privateKey,
    client_email: "agente@seahub-teste.iam.gserviceaccount.com",
  };
});

type Chamada = { url: string; method: string; body: string; headers: Headers };
let chamadas: Chamada[] = [];

function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  chamadas = [];
  // ⚠ O cache do access token é global ao módulo e sobreviveria entre casos:
  // sem isto, o segundo teste que pedisse token nunca chamaria o Google, e a
  // contagem de idas viraria ruído.
  limparCacheDeToken();

  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    chamadas.push({
      url: String(url),
      method: init.method ?? "GET",
      body: String(init.body ?? ""),
      headers: new Headers(init.headers as HeadersInit),
    });
    // Token diferente a cada ida: é o que deixa provar que duas chamadas
    // vieram do cache (mesmo token) ou de duas idas (tokens diferentes).
    return responder({
      access_token: `token-${chamadas.length}`,
      expires_in: 3600,
    });
  });
});

afterEach(() => vi.unstubAllGlobals());

function decodificar(parte: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(parte, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

/** Espera a falha e devolve o erro tipado — `rejects.toThrow` não dá acesso ao `codigo`. */
async function capturar(promessa: Promise<unknown>): Promise<GoogleAuthError> {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof GoogleAuthError) return erro;
    throw erro;
  }
  throw new Error("esperava GoogleAuthError, mas a promessa resolveu");
}

const AGORA = 1_780_000_000;

describe("montarAssertion", () => {
  it("assina com RS256 e diz QUAL chave assinou", () => {
    const [cabecalho] = montarAssertion(chave, ["a"], AGORA).split(".");

    expect(decodificar(cabecalho)).toEqual({
      alg: "RS256",
      typ: "JWT",
      // Sem o `kid`, uma chave rotacionada e outra ainda ativa viram tentativa
      // e erro do lado do Google.
      kid: "kid-da-chave-de-teste",
    });
  });

  it("o `aud` é a constante, NUNCA o token_uri que vem no JSON da chave", () => {
    const [, claims] = montarAssertion(chave, ["a"], AGORA).split(".");

    // O JSON da conta de serviço traz `https://accounts.google.com/o/oauth2/token`,
    // que é o endereço antigo. Ler dali funciona hoje e quebra quando o Google
    // mudar o que emite — e a falha volta como `invalid_grant`, que aponta para
    // a chave.
    expect(decodificar(claims).aud).toBe("https://oauth2.googleapis.com/token");
    expect(decodificar(claims).aud).toBe(URL_DO_TOKEN);
  });

  it("identifica a conta e lista os escopos separados por espaço", () => {
    const [, claims] = montarAssertion(
      chave,
      ["https://exemplo/um", "https://exemplo/dois"],
      AGORA,
    ).split(".");

    const corpo = decodificar(claims);
    expect(corpo.iss).toBe(chave.client_email);
    // Espaço, não vírgula: é o formato do OAuth 2.0, e vírgula devolve
    // `invalid_scope` sem dizer qual escopo estava errado.
    expect(corpo.scope).toBe("https://exemplo/um https://exemplo/dois");
  });

  it("vale exatamente uma hora, em SEGUNDOS", () => {
    const [, claims] = montarAssertion(chave, ["a"], AGORA).split(".");
    const corpo = decodificar(claims) as { iat: number; exp: number };

    expect(corpo.iat).toBe(AGORA);
    // ⚠ Uma hora é o TETO que o Google aceita. Passar disso — inclusive por
    // trocar segundos por milissegundos — devolve `invalid_grant: Invalid JWT
    // Signature`, uma mensagem que fala da assinatura e não da validade.
    expect(corpo.exp - corpo.iat).toBe(3600);
  });

  it("a assinatura confere com a chave pública do par", () => {
    const assertion = montarAssertion(chave, ["a"], AGORA);
    const [cabecalho, claims, assinatura] = assertion.split(".");

    const confere = createVerify("RSA-SHA256")
      .update(`${cabecalho}.${claims}`)
      .verify(chavePublica, Buffer.from(assinatura, "base64url"));

    // Prova que o que é assinado é o par cabeçalho.claims em base64url, e não
    // o JSON cru — trocar isso passa no typecheck e só falha no Google.
    expect(confere).toBe(true);
  });

  it("`sub` só existe quando há personificação — e some quando não há", () => {
    const [, semSub] = montarAssertion(chave, ["a"], AGORA).split(".");
    const [, comSub] = montarAssertion(chave, ["a"], AGORA, "pessoa@seahub.com.br").split(
      ".",
    );

    // ⚠ Não basta vir vazio: `sub: ""` num assertion sem delegação cadastrada
    // devolve `unauthorized_client`, e o operador vai procurar o problema no
    // Admin console de um Workspace que ele nem quis usar.
    expect("sub" in decodificar(semSub)).toBe(false);
    expect(decodificar(comSub).sub).toBe("pessoa@seahub.com.br");
  });
});

describe("obterAccessToken: o POST", () => {
  it("vai para o endpoint novo, como formulário e com o grant do JWT Bearer", async () => {
    await obterAccessToken(chave, ["a"]);

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(chamadas[0].method).toBe("POST");
    // Formulário, não JSON: este endpoint recusa `application/json` com um
    // `invalid_request` que não diz qual é o problema.
    expect(chamadas[0].headers.get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );

    const corpo = new URLSearchParams(chamadas[0].body);
    expect(corpo.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(corpo.get("assertion")?.split(".")).toHaveLength(3);
  });
});

describe("obterAccessToken: cache", () => {
  it("duas chamadas iguais fazem UMA ida ao Google", async () => {
    const primeiro = await obterAccessToken(chave, ["a"]);
    const segundo = await obterAccessToken(chave, ["a"]);

    // O token dura uma hora e o worker atende quatro conversas ao mesmo tempo:
    // assinar RSA e ir ao Google a cada tool seria custo no caminho mais quente
    // do sistema.
    expect(chamadas).toHaveLength(1);
    expect(segundo).toBe(primeiro);
  });

  it("escopos diferentes não compartilham token", async () => {
    await obterAccessToken(chave, ["a"]);
    await obterAccessToken(chave, ["b"]);

    // Um token só vale para os escopos que ele pediu. Reaproveitar entre
    // escopos diferentes daria `403` no meio do atendimento, não no login.
    expect(chamadas).toHaveLength(2);
  });

  it("⚠ personificar diferente NUNCA reaproveita o token do outro", async () => {
    const seVira = await obterAccessToken(chave, ["a"]);
    const daAna = await obterAccessToken(chave, ["a"], "ana@seahub.com.br");
    const doJoao = await obterAccessToken(chave, ["a"], "joao@seahub.com.br");

    // Este é o teste que impede a pior falha do módulo. Se a chave do cache
    // ignorasse `personificar`, o agente escreveria na planilha de OUTRA
    // pessoa — com `200` de resposta, sem erro nenhum, e ninguém descobriria
    // pelo painel.
    expect(chamadas).toHaveLength(3);
    expect(new Set([seVira, daAna, doJoao]).size).toBe(3);
  });
});

describe("obterAccessToken: erros traduzidos", () => {
  it("invalid_grant cita as três causas, inclusive o relógio", async () => {
    vi.stubGlobal("fetch", async () =>
      responder(
        { error: "invalid_grant", error_description: "Invalid JWT Signature." },
        400,
      ),
    );

    const erro = await capturar(obterAccessToken(chave, ["a"]));

    expect(erro.codigo).toBe("invalid_grant");
    // O código cru manda o operador rotacionar uma chave que pode estar boa. A
    // tradução tem de nomear as três causas — e o relógio é a que ninguém
    // desconfia, porque o container roda em UTC e a hora "parece" certa.
    expect(erro.message).toContain("outro projeto");
    expect(erro.message).toContain("relógio");
    expect(erro.message).toContain("quebras de linha");
  });

  it("unauthorized_client manda para o Admin console, que é onde se resolve", async () => {
    vi.stubGlobal("fetch", async () =>
      responder({ error: "unauthorized_client" }, 401),
    );

    const erro = await capturar(
      obterAccessToken(chave, ["a"], "pessoa@seahub.com.br"),
    );

    expect(erro.codigo).toBe("unauthorized_client");
    // O ajuste é no Workspace, não no Google Cloud — quem procura no Console
    // errado não acha a tela e conclui que a chave está quebrada.
    expect(erro.message).toContain("Admin console");
  });

  it("resposta 200 sem access_token também é falha", async () => {
    vi.stubGlobal("fetch", async () => responder({ expires_in: 3600 }));

    // Guardar `undefined` no cache faria toda chamada seguinte mandar
    // `Bearer undefined` e voltar 401 — erro na tool, longe da causa.
    const erro = await capturar(obterAccessToken(chave, ["a"]));
    expect(erro).toBeInstanceOf(GoogleAuthError);
  });
});
