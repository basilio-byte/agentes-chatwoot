import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { extrairBearer } from "@/server/mcp/token";
import { gravarLote } from "@/server/openclaws/gravar";
import { validarLote } from "@/server/openclaws/ingestao";
import { tokenDoColetorConfere } from "@/server/openclaws/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Um lote de 5.000 linhas de uso passa de 1 MB com folga; este é o teto do que
 * o servidor aceita ler. Maior que isso o coletor manda em lotes menores.
 */
const TETO_DO_CORPO_EM_BYTES = 4 * 1024 * 1024;

/**
 * Entrada do coletor do servidor dos OpenClaws.
 *
 * ⚠ **Autentica por token no cabeçalho, e não por sessão**: quem chama é um
 * script em outro servidor, sem navegador. O `proxy.ts` não cobre `/api/*` de
 * propósito, então a checagem mora aqui.
 *
 * `404` quando nenhum token foi gerado (a porta não existe ainda) e `401` quando
 * o token não confere — sem dizer qual parte falhou. Corpo recusado volta `422`
 * com o motivo, que o coletor imprime no log dele: lote descartado em silêncio é
 * o consumo daquela semana faltando sem ninguém saber.
 */
export async function POST(req: Request) {
  const config = await db.openClawConfig.findUnique({
    where: { id: "unico" },
    select: { tokenHash: true },
  });
  if (!config?.tokenHash) {
    return NextResponse.json({ erro: "O coletor dos OpenClaws não foi configurado." }, { status: 404 });
  }
  if (!tokenDoColetorConfere(extrairBearer(req.headers.get("authorization")), config.tokenHash)) {
    logger.warn("coletor dos OpenClaws recusado — token não confere");
    return NextResponse.json({ erro: "Token inválido." }, { status: 401 });
  }

  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (declarado > TETO_DO_CORPO_EM_BYTES) {
    return NextResponse.json({ erro: "Lote grande demais; mande em partes menores." }, { status: 413 });
  }
  // O cabeçalho é opcional e pode mentir: o teto vale também para o que chegou.
  const corpo = await req.text();
  if (Buffer.byteLength(corpo, "utf8") > TETO_DO_CORPO_EM_BYTES) {
    return NextResponse.json({ erro: "Lote grande demais; mande em partes menores." }, { status: 413 });
  }

  let bruto: unknown;
  try {
    bruto = JSON.parse(corpo);
  } catch {
    return NextResponse.json({ erro: "O corpo não é um JSON válido." }, { status: 400 });
  }

  const validado = validarLote(bruto);
  if (!validado.ok) {
    logger.warn({ erro: validado.erro }, "coletor dos OpenClaws: lote recusado");
    return NextResponse.json({ erro: validado.erro }, { status: 422 });
  }

  try {
    const gravado = await gravarLote(validado.lote);
    logger.info(gravado, "coletor dos OpenClaws: lote gravado");
    return NextResponse.json({ ok: true, ...gravado });
  } catch (erro) {
    logger.error(
      { erro: erro instanceof Error ? erro.message : String(erro) },
      "coletor dos OpenClaws: lote não gravado",
    );
    return NextResponse.json({ erro: "Não foi possível gravar o lote." }, { status: 500 });
  }
}

/** Conferência de setup: o coletor testa o token sem mandar dado. */
export async function GET(req: Request) {
  const config = await db.openClawConfig.findUnique({
    where: { id: "unico" },
    select: { tokenHash: true },
  });
  if (!config?.tokenHash) {
    return NextResponse.json({ erro: "O coletor dos OpenClaws não foi configurado." }, { status: 404 });
  }
  if (!tokenDoColetorConfere(extrairBearer(req.headers.get("authorization")), config.tokenHash)) {
    return NextResponse.json({ erro: "Token inválido." }, { status: 401 });
  }
  return NextResponse.json({ ok: true, configurado: true });
}
