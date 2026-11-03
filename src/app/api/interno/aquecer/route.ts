import { NextResponse } from "next/server";
import { aquecerOPainel } from "@/server/painel/leituras-remotas";
import { tokenDoAquecimentoConfere } from "@/server/painel/aquecer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * O worker pede, de dentro do container, para o painel deixar quentes as leituras
 * externas das telas (macros do Chatwoot, modelos da OpenAI, categorias do Conexa).
 * Ver `server/painel/aquecer.ts`.
 *
 * O token é derivado da AUTH_SECRET, que os dois processos já têm. Sem ele, a
 * resposta é 404 — a rota não confirma que existe. Não devolve dado nenhum: só o
 * tempo de cada leitura.
 */
export async function POST(req: Request) {
  if (!tokenDoAquecimentoConfere(req.headers.get("x-aquecer"))) {
    return NextResponse.json({ erro: "não encontrado" }, { status: 404 });
  }
  const tempos = await aquecerOPainel();
  return NextResponse.json({ ok: true, tempos });
}
