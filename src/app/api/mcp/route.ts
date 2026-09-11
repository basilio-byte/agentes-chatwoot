import { NextResponse } from "next/server";
import { autenticarMcp } from "@/server/mcp/autenticacao";
import { criarExecutor } from "@/server/mcp/executor";
import { CATALOGO } from "@/server/mcp/ferramentas";
import { consumirFreioMcp } from "@/server/mcp/freio";
import { CODIGO, tratarMensagem } from "@/server/mcp/protocolo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * O servidor MCP da plataforma (Streamable HTTP, sem sessão).
 *
 * Um POST por mensagem JSON-RPC; resposta sempre em JSON, nunca em SSE — nada
 * aqui precisa empurrar mensagem ao cliente. O protocolo mora em
 * `server/mcp/protocolo.ts`, puro e testado; esta rota só faz o que é de HTTP:
 * origem, token, freio e corpo.
 *
 * ⚠ O `proxy.ts` não cobre `/api/*`: a checagem do token aqui é a única porta.
 */

/** Um prompt longo com folga. Acima disso não é uso legítimo de ferramenta. */
const TETO_DO_CORPO = 1_000_000;

function recusa(
  status: number,
  mensagem: string,
  cabecalhos?: Record<string, string>,
) {
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code: CODIGO.REQUISICAO_INVALIDA, message: mensagem } },
    { status, headers: cabecalhos },
  );
}

function hostDaRequisicao(req: Request) {
  return req.headers.get("x-forwarded-host") ?? req.headers.get("host");
}

export async function POST(req: Request) {
  // Antes do token, como a especificação manda: é a defesa contra DNS
  // rebinding, em que uma página aberta no navegador fala com o servidor.
  // Cliente de linha de comando não manda `Origin`, e passa.
  const origem = req.headers.get("origin");
  if (origem) {
    let mesmaOrigem = false;
    try {
      mesmaOrigem = new URL(origem).host === hostDaRequisicao(req);
    } catch {
      mesmaOrigem = false;
    }
    if (!mesmaOrigem) return recusa(403, "Origem não permitida.");
  }

  const acesso = await autenticarMcp(req.headers.get("authorization"));
  if (!acesso) {
    return recusa(
      401,
      "Token do MCP ausente, inválido ou revogado. Gere um em Acesso MCP, no painel.",
      { "WWW-Authenticate": 'Bearer realm="seahub-agentes"' },
    );
  }

  const freio = await consumirFreioMcp(acesso.tokenId);
  if (!freio.pode) {
    return recusa(
      429,
      `Limite de chamadas deste token atingido. Tente de novo em ${Math.ceil(freio.esperaSegundos / 60)} minuto(s).`,
      { "Retry-After": String(freio.esperaSegundos) },
    );
  }

  const texto = await req.text();
  if (texto.length > TETO_DO_CORPO) {
    return recusa(413, "Requisição grande demais.");
  }

  let corpo: unknown;
  try {
    corpo = JSON.parse(texto);
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: CODIGO.PARSE, message: "JSON inválido." } },
      { status: 400 },
    );
  }

  // Mesmo jeito da tela do agente de montar a URL pública: funciona em local e
  // atrás do proxy do Easypanel sem variável de ambiente.
  const protocolo = req.headers.get("x-forwarded-proto") ?? "https";
  const baseUrl = `${protocolo}://${hostDaRequisicao(req) ?? "localhost:3000"}`;

  const executor = criarExecutor(CATALOGO, {
    tokenId: acesso.tokenId,
    usuario: acesso.usuario,
    baseUrl,
  });

  const resposta = await tratarMensagem(
    corpo,
    {
      versao: req.headers.get("mcp-protocol-version"),
      metodo: req.headers.get("mcp-method"),
      nome: req.headers.get("mcp-name"),
    },
    executor,
  );

  if (resposta.corpo === null) return new Response(null, { status: 202 });
  return NextResponse.json(resposta.corpo, { status: resposta.status });
}

/**
 * Sem fluxo SSE de servidor para cliente e sem sessão para encerrar: a
 * especificação aceita `405` para os dois.
 */
export async function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export async function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
