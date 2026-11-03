import { after, NextResponse } from "next/server";
import { IntegrationProvider } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { processarMacro, registrarEntrega } from "@/server/boas-vindas/processar";
import { lerConfigBoasVindas, tokenDoEnderecoConfere } from "@/server/boas-vindas/regras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * O endereço que a macro "Disparar Template Boas Vindas" do Chatwoot chama (ação
 * "Enviar evento de webhook"). Token no caminho, como no gatilho HTTP e no aviso do
 * Conexa: o Chatwoot não assina o corpo da macro nem deixa pôr cabeçalho, só a URL
 * é configurável.
 *
 * ⚠ **O corpo NÃO é fonte confiável.** Quem descobrir o endereço manda o que
 * quiser; por isso só valem os campos do formato da macro (`lerMacro`), o evento
 * precisa ser `macro.executed`, e o freio de reenvio e o teto por hora seguram o
 * pior caso.
 *
 * Responde `200` na hora e trabalha depois da resposta (`after`): o Chatwoot trata
 * resposta lenta como falha e reenvia. Só `401` e `404` são erro de protocolo.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const corpoCru = await req.text();

  const linha = await db.integration.findUnique({
    where: { provider: IntegrationProvider.BOAS_VINDAS },
    select: { config: true },
  });
  const hash = lerConfigBoasVindas(linha?.config).tokenHash;
  if (!hash) {
    return NextResponse.json({ erro: "O endereço do template de boas-vindas não foi gerado." }, { status: 404 });
  }
  if (!tokenDoEnderecoConfere(token, hash)) {
    logger.warn("template de boas-vindas rejeitado — token não confere");
    await registrarEntrega({ resultado: "rejeitado", detalhe: "o endereço não confere com o atual", eventType: "recusada" });
    return NextResponse.json({ erro: "Token inválido." }, { status: 401 });
  }

  let corpo: unknown = null;
  try {
    corpo = JSON.parse(corpoCru);
  } catch {
    corpo = null;
  }

  after(async () => {
    try {
      const desfecho = await processarMacro(corpo);
      logger.info({ resultado: desfecho.resultado }, "template de boas-vindas processado");
    } catch (erro) {
      logger.error({ erro }, "template de boas-vindas: erro inesperado");
      await registrarEntrega({
        resultado: "falhou",
        detalhe: `erro inesperado: ${erro instanceof Error ? erro.message : String(erro)}`,
        eventType: "erro inesperado",
      });
    }
  });
  return NextResponse.json({ ok: true });
}

/** Conferência de setup: abrir o endereço no navegador diz se o token está certo. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const linha = await db.integration.findUnique({
    where: { provider: IntegrationProvider.BOAS_VINDAS },
    select: { config: true },
  });
  const hash = lerConfigBoasVindas(linha?.config).tokenHash;
  if (!hash || !tokenDoEnderecoConfere(token, hash)) {
    return NextResponse.json({ erro: "Token inválido." }, { status: hash ? 401 : 404 });
  }
  return NextResponse.json({ ok: true, configurado: true });
}
