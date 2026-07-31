import { NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { ConversationStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { verificarAssinatura } from "@/server/integrations/chatwoot/assinatura";
import { obterSegredosDoBot } from "@/server/integrations/chatwoot/credenciais";
import { decidirSeResponde } from "@/server/integrations/chatwoot/eventos";
import { agendarAtendimento } from "@/server/queue/atendimento";
import { lerConversa, sincronizarResolucao } from "@/server/integrations/chatwoot/resolucao";

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

    // Deixa rastro no painel. Sem isto, secret errado era invisível: a entrega
    // voltava 401 antes de qualquer escrita e o operador só via silêncio, sem
    // saber se o Chatwoot sequer estava chamando.
    await registrarEntregaRecusada(agentId, req, verificacao.motivo);

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

  // O webhook DE BOT também recebe conversation_updated (visto em produção).
  // Aproveitar isso é o que faz a conversa resolvida zerar de verdade, sem
  // depender do webhook de conta estar configurado.
  const { resolvida } = await sincronizarResolucao(payload);
  if (resolvida) {
    await marcarEntrega(entrega, "resolvido", "conversa zerada: volta do começo");
    return NextResponse.json({ ok: true, resolvida: true });
  }

  // Decisão barata aqui para não encher a fila de ruído (typing, eco, nota
  // privada). O worker ainda reconfere o estado no banco depois do debounce.
  const decisao = decidirSeResponde(payload);
  if (!decisao.responder) {
    // Registra o status que veio no evento de conversa: sem isso, descobrir por
    // que uma resolução não foi detectada vira adivinhação sobre o payload.
    const lida = lerConversa(payload as Parameters<typeof lerConversa>[0]);
    logger.debug(
      { agentId, eventType, motivo: decisao.motivo },
      "evento recebido sem resposta",
    );
    await db.webhookEvent.update({
      where: { provider_externalId: { provider: "CHATWOOT", externalId: entrega } },
      data: {
        processedAt: new Date(),
        resultado: "ignorado",
        detalhe: lida.status
          ? `${decisao.motivo ?? "evento sem resposta"} · conversa ${lida.conversationId ?? "?"} está ${lida.status}`
          : (decisao.motivo ?? "evento sem resposta"),
      },
    });
    return NextResponse.json({ ok: true, respondera: false });
  }

  const agente = await db.agent.findUnique({
    where: { id: agentId },
    select: { active: true, debounceSeconds: true },
  });

  if (!agente?.active) {
    logger.info({ agentId }, "agente desligado — mensagem não será respondida");
    await marcarEntrega(entrega, "ignorado", "o agente está desligado no painel");
    return NextResponse.json({ ok: true, respondera: false });
  }

  await db.conversation.upsert({
    where: { chatwootConversationId: decisao.conversationId },
    update: {
      lastMessageAt: new Date(),
      contactName: decisao.contato.nome,
      contactIdentifier: decisao.contato.identificador,
    },
    create: {
      chatwootConversationId: decisao.conversationId,
      chatwootInboxId: decisao.inboxId,
      agentId,
      contactName: decisao.contato.nome,
      contactIdentifier: decisao.contato.identificador,
      lastMessageAt: new Date(),
    },
  });

  // Mensagem nova reabre o atendimento: encerrada volta a ser do bot, e volta
  // limpa — `historicoDesde` e o dono já foram zerados quando ela foi
  // resolvida. Sem isto o worker recusaria a conversa para sempre, porque ele
  // só processa status BOT.
  //
  // Só sai de CLOSED. HUMAN continua HUMAN: quem assumiu não perde a conversa
  // porque o cliente escreveu de novo.
  await db.conversation.updateMany({
    where: {
      chatwootConversationId: decisao.conversationId,
      status: ConversationStatus.CLOSED,
    },
    data: { status: ConversationStatus.BOT },
  });

  await agendarAtendimento(
    {
      chatwootConversationId: decisao.conversationId,
      agentId,
      inboxId: decisao.inboxId,
    },
    agente.debounceSeconds,
  );

  await marcarEntrega(
    entrega,
    "agendado",
    `conversa ${decisao.conversationId} na fila`,
  );

  logger.info(
    { agentId, eventType, conversa: decisao.conversationId },
    "atendimento agendado",
  );

  return NextResponse.json({ ok: true, respondera: true });
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

/** Marca o desfecho de uma entrega já registrada. Melhor esforço. */
async function marcarEntrega(
  externalId: string,
  resultado: string,
  detalhe: string,
) {
  try {
    await db.webhookEvent.update({
      where: { provider_externalId: { provider: "CHATWOOT", externalId } },
      data: { processedAt: new Date(), resultado, detalhe },
    });
  } catch (erro) {
    logger.warn({ externalId, erro }, "não consegui marcar o desfecho da entrega");
  }
}

/**
 * Registra uma entrega recusada na verificação de assinatura.
 *
 * O corpo NÃO é guardado: ele não foi verificado, então não é confiável. O que
 * importa aqui é que alguém bateu na porta e foi recusado — e por quê.
 */
async function registrarEntregaRecusada(
  agentId: string,
  req: Request,
  motivo: string,
) {
  try {
    await db.webhookEvent.create({
      data: {
        provider: "CHATWOOT",
        externalId:
          req.headers.get("x-chatwoot-delivery") ??
          `recusada-${crypto.randomUUID()}`,
        eventType: "assinatura-invalida",
        agentId,
        payload: {},
        processedAt: new Date(),
        resultado: "rejeitado",
        detalhe: motivo,
      },
    });
  } catch (erro) {
    logger.warn({ agentId, erro }, "não consegui registrar a entrega recusada");
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
