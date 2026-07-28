import { NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { verificarAssinatura } from "@/server/integrations/chatwoot/assinatura";
import { obterSegredosDoBot } from "@/server/integrations/chatwoot/credenciais";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recebe os eventos do Agent Bot do Chatwoot.
 *
 * Uma URL por agente porque cada bot tem o seu secret — a URL diz qual chave usar
 * antes de verificar a assinatura, em vez de ter de confiar no payload para
 * escolhê-la.
 *
 * A rota fica fora do `proxy.ts` (que ignora `/api`), então é pública de
 * propósito: quem protege é o HMAC.
 *
 * Responde 200 rápido e só grava. O processamento é da fila (Fase 2, fatia 2) —
 * o Chatwoot não pode ficar esperando a chamada ao modelo.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;

  // Precisa ser o texto cru: reserializar o JSON muda os bytes e a assinatura
  // nunca mais confere.
  const corpoCru = await req.text();

  const segredos = await obterSegredosDoBot(agentId);
  if (!segredos) {
    logger.warn({ agentId }, "webhook para agente sem bot configurado");
    return NextResponse.json(
      { erro: "Agente sem bot do Chatwoot configurado." },
      { status: 404 },
    );
  }

  const verificacao = verificarAssinatura({
    corpoCru,
    assinatura: req.headers.get("x-chatwoot-signature"),
    timestamp: req.headers.get("x-chatwoot-timestamp"),
    secret: segredos.webhookSecret,
  });

  if (!verificacao.ok) {
    logger.warn(
      { agentId, motivo: verificacao.motivo },
      "webhook do Chatwoot rejeitado",
    );
    return NextResponse.json({ erro: "Assinatura inválida." }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(corpoCru);
  } catch {
    return NextResponse.json({ erro: "Corpo não é JSON." }, { status: 400 });
  }

  const eventType = String(payload.event ?? "desconhecido");
  const entrega =
    req.headers.get("x-chatwoot-delivery") ??
    // Instâncias antigas podem não mandar o header; a combinação evento+id
    // ainda é estável o suficiente para deduplicar.
    `${eventType}:${String(payload.id ?? "sem-id")}`;

  try {
    await db.webhookEvent.create({
      data: {
        provider: "CHATWOOT",
        externalId: entrega,
        eventType,
        agentId,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  } catch (erro) {
    // Violação da unique = reenvio do Chatwoot. É sucesso, não erro: responder
    // 200 para ele parar de tentar.
    if (ehConflitoDeUnique(erro)) {
      logger.debug({ agentId, entrega }, "entrega repetida — ignorada");
      return NextResponse.json({ ok: true, repetida: true });
    }
    throw erro;
  }

  logger.info({ agentId, eventType, entrega }, "webhook do Chatwoot recebido");

  return NextResponse.json({ ok: true });
}

/**
 * Conferência de setup: abrir a URL no navegador diz se ela está certa e se o
 * bot já foi configurado. Não devolve nada sensível.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;
  const bot = await db.agentChatwootBot.findUnique({
    where: { agentId },
    select: { botName: true },
  });

  return NextResponse.json({
    ok: true,
    endpoint: "chatwoot",
    configurado: Boolean(bot),
    dica: bot
      ? "Endpoint pronto. O Chatwoot deve enviar POST assinado para esta URL."
      : "Cadastre o token e o secret do bot no painel, na tela do agente.",
  });
}

function ehConflitoDeUnique(erro: unknown) {
  return (
    typeof erro === "object" &&
    erro !== null &&
    "code" in erro &&
    (erro as { code?: string }).code === "P2002"
  );
}
