import { after, NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { IntegrationProvider } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { lerConfigNotasFiscais } from "@/server/notas-fiscais/config";
import {
  avisoDizQueFoiPaga,
  idDaCobrancaNoAviso,
  processarAviso,
  tokenDoAvisoConfere,
} from "@/server/notas-fiscais/aviso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDER = "CONEXA_AVISO";

/**
 * O aviso do Conexa de cobrança paga (ou gerada): a nota sai na hora, não até 35
 * minutos depois. Token no endereço, como no gatilho HTTP — o Conexa só deixa
 * configurar a URL.
 *
 * ⚠ **Só o número da cobrança do corpo é aproveitado.** Valor, itens e cliente
 * vêm da API do Conexa, relida em `processarAviso`; o corpo pode ser forjado por
 * quem descobrir o endereço. E o corpo inteiro nem fica guardado na entrega: ele
 * traz nome e e-mail de cliente, e a lista de entregas é lida pela equipe toda.
 *
 * Responde `200` rápido e trabalha depois da resposta (`after`): o Conexa trata
 * resposta lenta ou não-2xx como falha e reenvia. Só `401`/`404` são erro de
 * protocolo.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const corpoCru = await req.text();

  const linha = await db.integration.findUnique({
    where: { provider: IntegrationProvider.NOTAS_FISCAIS },
    select: { config: true },
  });
  const hash = lerConfigNotasFiscais(linha?.config).aviso.tokenHash;
  if (!hash) {
    return NextResponse.json({ erro: "O aviso do Conexa não foi configurado." }, { status: 404 });
  }
  if (!tokenDoAvisoConfere(token, hash)) {
    logger.warn("aviso do Conexa rejeitado — token não confere");
    await registrar("rejeitado", "token não confere", null, "recusado", {});
    return NextResponse.json({ erro: "Token inválido." }, { status: 401 });
  }

  let corpo: unknown = null;
  try {
    corpo = JSON.parse(corpoCru);
  } catch {
    corpo = null;
  }
  const cobrancaId = idDaCobrancaNoAviso(corpo);
  if (cobrancaId === null) {
    await registrar("ignorado", "o aviso veio sem o número da cobrança", null, "sem cobrança", {});
    return NextResponse.json({ ok: true, processado: false });
  }
  const esperavaPaga = avisoDizQueFoiPaga(corpo);
  const status = typeof (corpo as { status?: unknown })?.status === "string" ? String((corpo as { status: string }).status) : "";

  const entrega =
    req.headers.get("x-idempotency-key") ?? req.headers.get("x-request-id") ?? crypto.randomUUID();
  const id = await registrar("recebido", "na fila de processamento", cobrancaId, status || "aviso", { cobrancaId, status }, entrega);
  if (id === "repetida") return NextResponse.json({ ok: true, repetida: true });

  after(async () => {
    const desfecho = await processarAviso(cobrancaId, { esperavaPaga });
    if (id) {
      await db.webhookEvent
        .update({
          where: { id },
          data: { resultado: desfecho.resultado, detalhe: desfecho.detalhe.slice(0, 500), processedAt: new Date() },
        })
        .catch(() => {});
    }
    logger.info({ cobrancaId, ...desfecho }, "aviso do Conexa processado");
  });
  return NextResponse.json({ ok: true, processado: true });
}

/** Conferência de setup: abrir o endereço no navegador diz se o token está certo. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const linha = await db.integration.findUnique({
    where: { provider: IntegrationProvider.NOTAS_FISCAIS },
    select: { config: true },
  });
  const hash = lerConfigNotasFiscais(linha?.config).aviso.tokenHash;
  if (!hash || !tokenDoAvisoConfere(token, hash)) {
    return NextResponse.json({ erro: "Token inválido." }, { status: hash ? 401 : 404 });
  }
  return NextResponse.json({ ok: true, configurado: true });
}

/** Grava a entrega (sem o corpo do aviso). `"repetida"` quando o Conexa reenviou a mesma. */
async function registrar(
  resultado: string,
  detalhe: string,
  cobrancaId: number | null,
  eventType: string,
  payload: Record<string, unknown>,
  externalId: string = crypto.randomUUID(),
): Promise<string | "repetida" | null> {
  try {
    const criada = await db.webhookEvent.create({
      data: {
        provider: PROVIDER,
        externalId,
        eventType,
        payload: payload as Prisma.InputJsonValue,
        resultado,
        detalhe: cobrancaId === null ? detalhe : `cobrança ${cobrancaId}: ${detalhe}`,
      },
      select: { id: true },
    });
    return criada.id;
  } catch (erro) {
    if ((erro as { code?: string }).code === "P2002") return "repetida";
    logger.warn({ erro: erro instanceof Error ? erro.message : String(erro) }, "aviso do Conexa: entrega não gravada");
    return null;
  }
}
