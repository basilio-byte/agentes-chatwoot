import { createSign } from "node:crypto";
import { URL_DO_TOKEN, type ChaveDeServico } from "./config";

/**
 * Troca a chave de conta de serviço por um access token, pelo fluxo JWT Bearer.
 *
 * Sem SDK, e isso não é teimosia: `googleapis` traz centenas de módulos para
 * fazer o que cabe em cem linhas de `fetch` + `node:crypto`, e o worker é um
 * bundle esbuild com lista explícita de externals (`package.json`,
 * `build:worker`). Toda dependência nova ali é um risco de bundle que só
 * aparece em produção. O resto do projeto escreve cliente HTTP na mão pelo
 * mesmo motivo — ClickUp, Conexa e ZapSign são todos assim.
 */

/** Margem antes de considerar o token vencido. */
const MARGEM_SEGUNDOS = 300;

/** Validade máxima que o Google aceita no assertion. */
const VALIDADE_SEGUNDOS = 3600;

function base64url(dado: Buffer | string): string {
  return Buffer.from(dado)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Monta e assina o JWT que vale como credencial na troca por access token.
 *
 * ⚠ **`aud` é `URL_DO_TOKEN`, não o `token_uri` do JSON** — ver a constante.
 *
 * ⚠ **`exp - iat` no máximo 3600, em SEGUNDOS.** Passar disso, ou o relógio do
 * container derivar, devolve `invalid_grant: Invalid JWT Signature` — uma
 * mensagem que aponta para a chave e não para a hora, e manda o operador
 * rotacionar uma credencial que está boa.
 */
export function montarAssertion(
  chave: ChaveDeServico,
  escopos: readonly string[],
  agoraEmSegundos: number,
  personificar?: string,
): string {
  const cabecalho = {
    alg: "RS256",
    typ: "JWT",
    // Diz ao Google QUAL das chaves da conta assinou. Sem isto, uma chave
    // rotacionada e outra ainda ativa viram tentativa e erro do lado de lá.
    kid: chave.private_key_id,
  };

  const claims: Record<string, unknown> = {
    iss: chave.client_email,
    scope: escopos.join(" "),
    aud: URL_DO_TOKEN,
    iat: agoraEmSegundos,
    exp: agoraEmSegundos + VALIDADE_SEGUNDOS,
  };

  // `sub` só existe em domain-wide delegation. Mandá-lo vazio, ou mandá-lo sem
  // ter cadastrado o Client ID no Admin console, devolve `unauthorized_client`.
  if (personificar) claims.sub = personificar;

  const corpo = `${base64url(JSON.stringify(cabecalho))}.${base64url(
    JSON.stringify(claims),
  )}`;

  const assinatura = createSign("RSA-SHA256")
    .update(corpo)
    .sign(chave.private_key);

  return `${corpo}.${base64url(assinatura)}`;
}

export class GoogleAuthError extends Error {
  constructor(
    readonly codigo: string,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "GoogleAuthError";
  }
}

/**
 * Traduz o erro do endpoint de token para algo que aponte a causa certa.
 *
 * O vocabulário do Google aqui é curto e enganoso: o mesmo `invalid_grant`
 * cobre chave errada, quebra de linha destruída e relógio fora de hora. Deixar
 * o código cru chegar ao modelo faz ele dizer ao cliente que "houve um problema
 * de autenticação", e faz o operador trocar a credencial que está certa.
 */
function traduzirErroDeToken(codigo: string, descricao: string): string {
  switch (codigo) {
    case "invalid_grant":
      return `O Google recusou a chave de serviço (invalid_grant${
        descricao ? `: ${descricao}` : ""
      }). São três causas possíveis, nesta ordem de probabilidade: o JSON colado é de outro projeto ou a chave foi apagada no Console; o relógio do servidor está fora de hora (o token vale no máximo 1 hora e o Google confere); ou a chave privada foi editada e perdeu as quebras de linha. Cole o JSON de novo, sem alterar nada.`;
    case "unauthorized_client":
      return `O Google recusou a personificação (unauthorized_client${
        descricao ? `: ${descricao}` : ""
      }). Isso só acontece com o campo "Personificar" preenchido: o Client ID da conta de serviço precisa estar cadastrado no Admin console do Workspace, com EXATAMENTE estes escopos. Acrescentar escopo aqui sem acrescentar lá dá este erro.`;
    case "invalid_scope":
      return "O Google recusou os escopos pedidos. Confira se as APIs do Drive, Sheets e Docs estão ativadas no projeto.";
    default:
      return `O Google recusou a autenticação (${codigo}${
        descricao ? `: ${descricao}` : ""
      }).`;
  }
}

type Entrada = { token: string; expiraEm: number };

/**
 * Cache do access token, em memória do processo.
 *
 * ⚠ **A chave inclui os escopos e o `personificar`, não só a conta.** Cachear
 * só pela conta devolveria o token de OUTRO usuário quando a personificação
 * estiver em uso — falha silenciosa que só apareceria como "o agente escreveu
 * na planilha errada".
 *
 * Em memória, e nunca no banco, pelo mesmo motivo do cache do catálogo de
 * modelos: é dado derivado, com validade de uma hora. Persistir criaria uma
 * escrita de credencial a partir do runner, que é justamente o que a conta de
 * serviço existe para evitar.
 */
const cache = new Map<string, Entrada>();

/**
 * Requisições em voo, para não assinar quatro vezes o mesmo JWT.
 *
 * A concorrência do worker é 4: sem isto, quatro conversas que chegam juntas
 * fazem quatro assinaturas RSA e quatro idas ao Google no caminho mais quente
 * do sistema, e três delas jogam o resultado fora.
 */
const emVoo = new Map<string, Promise<string>>();

function chaveDoCache(
  chave: ChaveDeServico,
  escopos: readonly string[],
  personificar?: string,
): string {
  return [chave.client_email, [...escopos].sort().join(" "), personificar ?? ""].join(
    "|",
  );
}

/** Só para os testes: o cache é global e sobreviveria entre casos. */
export function limparCacheDeToken(): void {
  cache.clear();
  emVoo.clear();
}

export async function obterAccessToken(
  chave: ChaveDeServico,
  escopos: readonly string[],
  personificar?: string,
): Promise<string> {
  const id = chaveDoCache(chave, escopos, personificar);
  const agora = Math.floor(Date.now() / 1000);

  const guardado = cache.get(id);
  if (guardado && guardado.expiraEm - MARGEM_SEGUNDOS > agora) {
    return guardado.token;
  }

  const jaPedido = emVoo.get(id);
  if (jaPedido) return jaPedido;

  const pedido = trocarPorToken(chave, escopos, agora, personificar)
    .then((entrada) => {
      cache.set(id, entrada);
      return entrada.token;
    })
    .finally(() => {
      emVoo.delete(id);
    });

  emVoo.set(id, pedido);
  return pedido;
}

async function trocarPorToken(
  chave: ChaveDeServico,
  escopos: readonly string[],
  agora: number,
  personificar?: string,
): Promise<Entrada> {
  const assertion = montarAssertion(chave, escopos, agora, personificar);

  const resposta = await fetch(URL_DO_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const corpo = (await resposta.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!resposta.ok || !corpo.access_token) {
    const codigo = corpo.error ?? `http_${resposta.status}`;
    throw new GoogleAuthError(
      codigo,
      traduzirErroDeToken(codigo, corpo.error_description ?? ""),
    );
  }

  return {
    token: corpo.access_token,
    expiraEm: agora + (corpo.expires_in ?? VALIDADE_SEGUNDOS),
  };
}
