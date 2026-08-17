import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { verificarAssinatura } from "@/server/integrations/chatwoot/assinatura";
import {
  clienteDoAgente,
  obterSecretDaConta,
} from "@/server/integrations/chatwoot/credenciais";
import { podeAgir } from "@/server/integrations/chatwoot/regras";
import { donoEhHumano } from "@/server/integrations/chatwoot/humanos";
import { eventoChatwootSchema } from "@/server/integrations/chatwoot/eventos";
import { entregarAoHumano, sincronizarResolucao } from "@/server/integrations/chatwoot/resolucao";
import { ConversationStatus } from "@/generated/prisma/enums";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook **de conta** do Chatwoot (Configurações → Integrações → Webhooks).
 *
 * Existe por um motivo específico: o webhook de Agent Bot pode não entregar
 * `conversation_status_changed`. Sem esse evento, uma conversa resolvida em
 * silêncio e reaberta dias depois arrastaria o contexto antigo.
 *
 * As regras de "não interferir" **não dependem** deste endpoint — o worker
 * confere o estado ao vivo antes de responder. Aqui é só precisão do corte de
 * histórico.
 */
export async function POST(req: Request) {
  const corpoCru = await req.text();

  const secret = await obterSecretDaConta();
  if (!secret) {
    return NextResponse.json(
      { erro: "Secret do webhook de conta não configurado." },
      { status: 404 },
    );
  }

  const verificacao = verificarAssinatura({
    corpoCru,
    assinatura: req.headers.get("x-chatwoot-signature"),
    timestamp: req.headers.get("x-chatwoot-timestamp"),
    secret,
  });

  if (!verificacao.ok) {
    logger.warn({ motivo: verificacao.motivo }, "webhook de conta rejeitado");
    return NextResponse.json({ erro: "Assinatura inválida." }, { status: 401 });
  }

  const parsed = eventoChatwootSchema.safeParse(JSON.parse(corpoCru || "{}"));
  if (!parsed.success) {
    return NextResponse.json({ ok: true, ignorado: "formato" });
  }

  const evento = parsed.data;
  const conversa = evento.conversation;
  const conversationId = conversa?.id;

  if (!conversationId) {
    return NextResponse.json({ ok: true, ignorado: "sem conversa" });
  }

  // Só interessam eventos que mudam quem pode falar na conversa.
  if (
    !["conversation_status_changed", "conversation_updated"].includes(
      evento.event,
    )
  ) {
    return NextResponse.json({ ok: true, ignorado: evento.event });
  }

  const conhecida = await db.conversation.findUnique({
    where: { chatwootConversationId: conversationId },
    select: { id: true, portaAgentId: true },
  });
  if (!conhecida) {
    // Conversa que nunca passou por um agente nosso — nada a sincronizar.
    return NextResponse.json({ ok: true, ignorado: "conversa desconhecida" });
  }

  const { resolvida } = await sincronizarResolucao(evento);
  if (resolvida) return NextResponse.json({ ok: true, resolvida: true });

  const donoId = conversa?.assignee_id ?? conversa?.meta?.assignee?.id ?? null;

  // Sem esta conferência, o Chatwoot atribuindo o próprio bot fazia esta rota
  // gravar `HUMAN` no nosso banco — e `HUMAN` é grudento: o worker recusa a
  // conversa, o vigia não olha para ela, e a mensagem nova do cliente só a tira
  // de `CLOSED`, nunca de `HUMAN`. A conversa morria aqui, não no Chatwoot.
  const veredito = podeAgir({
    status: conversa?.status,
    assigneeId: donoId,
    donoEhHumano: await donoEhPessoa(conhecida.portaAgentId, donoId),
  });

  if (veredito.pode) {
    await db.conversation.updateMany({
      where: { chatwootConversationId: conversationId },
      // Só o status: o relógio da espera continua correndo, porque quem deve
      // resposta ao cliente segue sendo o bot.
      data: { status: ConversationStatus.BOT },
    });
  } else {
    await entregarAoHumano(
      conversationId,
      veredito.motivo ?? "assumida no Chatwoot",
    );
  }

  return NextResponse.json({ ok: true, podeResponder: veredito.pode });
}

/**
 * O responsável da conversa é gente?
 *
 * `undefined` quando não há dono ou não deu para conferir — é o valor que faz a
 * regra global manter o comportamento conservador (trata como pessoa e cala).
 * Melhor esforço: falha aqui não pode derrubar a entrega do webhook.
 */
async function donoEhPessoa(
  portaAgentId: string | null,
  donoId: number | null,
): Promise<boolean | undefined> {
  if (donoId == null || !portaAgentId) return undefined;

  try {
    const cliente = await clienteDoAgente(portaAgentId);
    if (!cliente) return undefined;
    return await donoEhHumano(cliente, donoId);
  } catch (erro) {
    logger.warn({ portaAgentId, erro }, "não consegui conferir o dono da conversa");
    return undefined;
  }
}

/** Conferência de setup: confirma a URL e se o secret já foi cadastrado. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "chatwoot-conta",
    configurado: Boolean(await obterSecretDaConta()),
    dica: "Cadastre este endereço em Configurações → Integrações → Webhooks do Chatwoot, assinando conversation_status_changed e conversation_updated.",
  });
}
