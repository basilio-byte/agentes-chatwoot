import { NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { decifrar } from "@/lib/crypto";
import { tokenConfere } from "@/server/gatilho/token";
import { avaliarGatilho } from "@/server/gatilho/anti-loop";
import { extrairEventType } from "@/server/gatilho/payload";
import { agendarGatilho } from "@/server/queue/gatilho";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDER = "TRIGGER";

/**
 * Aciona um agente diretamente por POST de um sistema externo (ClickUp, n8n,
 * curl), fora de uma conversa do Chatwoot.
 *
 * Token no path, não em header nem em query string: é o único grau de
 * liberdade que o pior caso (o ClickUp não permite anexar cabeçalho nenhum ao
 * registrar um webhook — só a URL é configurável) garante, e que qualquer
 * outro chamador genérico também aceita.
 *
 * Responde 200 rápido para tudo que não é erro de protocolo — inclusive
 * gatilho desligado, cooldown ativo ou teto estourado — porque para quem
 * chama essas são decisões nossas, não falhas. A maioria dos sistemas de
 * webhook trata não-2xx como falha e reage agressivamente (reenvio, ou até
 * desativa o webhook do lado dele); só `401`/`404` são de fato "conserte sua
 * configuração".
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ agentId: string; token: string }> },
) {
  const { agentId, token } = await params;

  const corpoCru = await req.text();

  const trigger = await db.agentTrigger.findUnique({ where: { agentId } });
  if (!trigger) {
    logger.warn({ agentId }, "webhook de gatilho para agente sem gatilho configurado");
    return NextResponse.json({ erro: "Agente sem gatilho configurado." }, { status: 404 });
  }

  if (!tokenConfere(token, decifrar(trigger))) {
    logger.warn({ agentId }, "webhook de gatilho rejeitado — token não confere");
    await registrarEntregaRecusada(agentId, "token não confere");
    return NextResponse.json({ erro: "Token inválido." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(corpoCru);
  } catch {
    // Payload é arbitrário por definição — nem todo chamador manda JSON.
    payload = { raw: corpoCru };
  }

  const eventType = extrairEventType(payload);
  const entrega =
    req.headers.get("x-idempotency-key") ??
    req.headers.get("x-request-id") ??
    crypto.randomUUID();

  let webhookEventId: string;
  try {
    const criado = await db.webhookEvent.create({
      data: {
        provider: PROVIDER,
        externalId: entrega,
        eventType,
        agentId,
        payload: payload as Prisma.InputJsonValue,
      },
    });
    webhookEventId = criado.id;
  } catch (erro) {
    if (ehConflitoDeUnique(erro)) {
      logger.debug({ agentId, entrega }, "entrega de gatilho repetida — ignorada");
      return NextResponse.json({ ok: true, repetida: true });
    }
    throw erro;
  }

  if (!trigger.enabled) {
    await marcarEntrega(webhookEventId, "ignorado", "gatilho está desligado no painel");
    return NextResponse.json({ ok: true, executado: false });
  }

  const agente = await db.agent.findUnique({
    where: { id: agentId },
    select: { active: true, archivedAt: true },
  });
  if (!agente?.active || agente.archivedAt) {
    await marcarEntrega(webhookEventId, "ignorado", "o agente está desligado ou arquivado");
    return NextResponse.json({ ok: true, executado: false });
  }

  const veredito = await avaliarGatilho(agentId, payload);
  if (!veredito.pode) {
    if (veredito.motivo === "cooldown_do_recurso") {
      await marcarEntrega(
        webhookEventId,
        "ignorado",
        "cooldown: o mesmo recurso disparou o gatilho de novo muito rápido — provável eco da própria ação do agente",
      );
      return NextResponse.json({ ok: true, executado: false });
    }

    // Teto de execuções estourado: a rede de segurança age forte — desliga o
    // gatilho sozinho — e deixa rastro no Postgres, não só no log.
    const motivo = `desligado automaticamente: ${veredito.execucoesNaJanela} execuções na janela de segurança`;
    await db.agentTrigger.update({
      where: { agentId },
      data: {
        enabled: false,
        pausadoAutomaticamenteEm: new Date(),
        pausadoAutomaticamenteMotivo: motivo,
      },
    });
    logger.error({ agentId, execucoes: veredito.execucoesNaJanela }, "gatilho auto-desligado por excesso de execuções");
    await marcarEntrega(webhookEventId, "rejeitado", motivo);
    return NextResponse.json({ ok: true, executado: false });
  }

  await agendarGatilho({ agentId, webhookEventId, payload, eventType });
  await marcarEntrega(webhookEventId, "agendado", `evento "${eventType}" na fila`);

  logger.info({ agentId, eventType }, "gatilho agendado");
  return NextResponse.json({ ok: true, executado: true });
}

/**
 * Conferência de setup: abrir a URL no navegador (ou um GET de teste) diz se
 * ela está certa. Exige o token correto — não devolve nada sensível de volta.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ agentId: string; token: string }> },
) {
  const { agentId, token } = await params;

  const trigger = await db.agentTrigger.findUnique({ where: { agentId } });
  if (!trigger || !tokenConfere(token, decifrar(trigger))) {
    return NextResponse.json({ erro: "Não encontrado." }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    endpoint: "gatilho",
    configurado: true,
    enabled: trigger.enabled,
    dica: trigger.enabled
      ? "Endpoint pronto. Envie POST com o payload que quiser."
      : "O gatilho está desligado no painel — ligue-o antes de configurar o sistema externo.",
  });
}

/** Marca o desfecho de uma entrega já registrada. Melhor esforço. */
async function marcarEntrega(webhookEventId: string, resultado: string, detalhe: string) {
  try {
    await db.webhookEvent.update({
      where: { id: webhookEventId },
      data: { processedAt: new Date(), resultado, detalhe },
    });
  } catch (erro) {
    logger.warn({ webhookEventId, erro }, "não consegui marcar o desfecho da entrega");
  }
}

/**
 * Registra uma entrega recusada na verificação de token.
 *
 * O corpo NÃO é guardado: ele não foi verificado, então não é confiável — o
 * que importa aqui é que alguém bateu na porta e foi recusado, e por quê.
 */
async function registrarEntregaRecusada(agentId: string, motivo: string) {
  try {
    await db.webhookEvent.create({
      data: {
        provider: PROVIDER,
        externalId: `recusada-${crypto.randomUUID()}`,
        eventType: "token-invalido",
        agentId,
        payload: {},
        processedAt: new Date(),
        resultado: "rejeitado",
        detalhe: motivo,
      },
    });
  } catch (erro) {
    logger.warn({ agentId, erro }, "não consegui registrar a entrega de gatilho recusada");
  }
}

function ehConflitoDeUnique(erro: unknown) {
  return (
    typeof erro === "object" &&
    erro !== null &&
    "code" in erro &&
    (erro as { code?: string }).code === "P2002"
  );
}
