import { z } from "zod";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { IntegrationProvider, PrazoStatus } from "@/generated/prisma/enums";
import type { ChatwootClient } from "@/server/integrations/chatwoot/client";
import { clienteDoAgente } from "@/server/integrations/chatwoot/credenciais";
import { resolverAtendente } from "@/server/integrations/chatwoot/atendentes";
import { entregarAoHumano } from "@/server/integrations/chatwoot/resolucao";
import { decidirPrazo, type AcaoDoPrazo } from "./decisao";

/**
 * Executa os prazos vencidos — chamado pelo vigia a cada minuto.
 *
 * A ordem de cada prazo é sempre a mesma, e é ela que sustenta a garantia de não
 * se meter em atendimento de pessoa: trava o prazo, confere o Chatwoot AO VIVO
 * (conversa, dono e mensagens), decide pela função pura e só então age — a
 * leitura e a escrita coladas, para a janela em que alguém poderia agir no meio
 * ficar em milissegundos.
 */

const POR_RODADA = 50;

const acaoSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("reatribuir"), atendente: z.string().min(1) }),
  z.object({ tipo: z.literal("mensagem"), texto: z.string().min(1) }),
  z.object({
    tipo: z.literal("atribuir"),
    atendente: z.string().min(1),
    aviso: z.string().min(1),
  }),
]);

type Prazo = NonNullable<Awaited<ReturnType<typeof db.prazoDeConversa.findFirst>>>;
type Fim = { status: PrazoStatus; resultado: string | null };

export type RodadaDePrazos = {
  vistos: number;
  executados: number;
  cancelados: number;
  descartados: number;
  falhas: number;
};

export async function executarPrazosVencidos(agora = Date.now()): Promise<RodadaDePrazos> {
  const rodada: RodadaDePrazos = {
    vistos: 0,
    executados: 0,
    cancelados: 0,
    descartados: 0,
    falhas: 0,
  };

  const vencidos = await db.prazoDeConversa.findMany({
    where: { status: PrazoStatus.PENDENTE, venceEm: { lte: new Date(agora) } },
    orderBy: { venceEm: "asc" },
    take: POR_RODADA,
  });
  if (vencidos.length === 0) return rodada;
  rodada.vistos = vencidos.length;

  const integracao = await db.integration.findUnique({
    where: { provider: IntegrationProvider.PRAZOS },
    select: { id: true, enabled: true },
  });

  for (const prazo of vencidos) {
    // Trava: duas voltas do relógio, ou duas réplicas, nunca agem no mesmo prazo.
    const pego = await db.prazoDeConversa.updateMany({
      where: { id: prazo.id, status: PrazoStatus.PENDENTE },
      data: { status: PrazoStatus.EXECUTANDO },
    });
    if (pego.count !== 1) continue;

    let fim: Fim;
    try {
      fim = await tratar(prazo, agora, integracao);
    } catch (erro) {
      logger.error(
        { prazo: prazo.id, conversa: prazo.chatwootConversationId, erro },
        "prazo da conversa falhou",
      );
      fim = {
        status: PrazoStatus.FALHOU,
        resultado: erro instanceof Error ? erro.message : String(erro),
      };
    }

    await db.prazoDeConversa.update({
      where: { id: prazo.id },
      data: {
        status: fim.status,
        resultado: fim.resultado?.slice(0, 2000) ?? null,
        finalizadoEm: fim.status === PrazoStatus.PENDENTE ? null : new Date(),
      },
    });

    if (fim.status === PrazoStatus.EXECUTADO) rodada.executados++;
    else if (fim.status === PrazoStatus.CANCELADO) rodada.cancelados++;
    else if (fim.status === PrazoStatus.DESCARTADO) rodada.descartados++;
    else if (fim.status === PrazoStatus.FALHOU) rodada.falhas++;

    logger.info(
      {
        prazo: prazo.id,
        conversa: prazo.chatwootConversationId,
        tipo: prazo.tipo,
        status: fim.status,
        resultado: fim.resultado,
      },
      "prazo da conversa tratado",
    );
  }

  return rodada;
}

async function tratar(
  prazo: Prazo,
  agora: number,
  integracao: { id: string; enabled: boolean } | null,
): Promise<Fim> {
  // Desligar a integração é o botão de parada: prazo pendente não age mais.
  if (!integracao?.enabled) {
    return { status: PrazoStatus.DESCARTADO, resultado: "integração de prazos desligada" };
  }
  const ligadaNoAgente = await db.agentIntegration.findFirst({
    where: { agentId: prazo.agentId, integrationId: integracao.id, enabled: true },
    select: { id: true },
  });
  if (!ligadaNoAgente) {
    return {
      status: PrazoStatus.DESCARTADO,
      resultado: "integração de prazos desligada para o agente",
    };
  }

  const acao = acaoSchema.safeParse(prazo.acao);
  if (!acao.success) {
    return { status: PrazoStatus.FALHOU, resultado: "ação do prazo em formato inesperado" };
  }

  const cliente = await clienteDoAgente(prazo.portaAgentId);
  if (!cliente) {
    return {
      status: PrazoStatus.DESCARTADO,
      resultado: "sem credencial do Chatwoot para a porta desta conversa",
    };
  }

  const conversaId = prazo.chatwootConversationId;
  const [aoVivo, mensagens, conversaNoBanco] = await Promise.all([
    cliente.obterConversa(conversaId),
    cliente.listarMensagens(conversaId),
    db.conversation.findUnique({
      where: { chatwootConversationId: conversaId },
      select: { agentId: true },
    }),
  ]);

  const decisao = decidirPrazo({
    prazo: {
      tipo: prazo.tipo,
      minutos: prazo.minutos,
      venceEm: prazo.venceEm,
      referenciaMensagemId: prazo.referenciaMensagemId,
      donoId: prazo.donoId,
      agentId: prazo.agentId,
    },
    agora,
    conversa: aoVivo,
    agentIdDaConversa: conversaNoBanco?.agentId ?? null,
    mensagens,
  });

  switch (decisao.acao) {
    case "aguardar":
      return { status: PrazoStatus.PENDENTE, resultado: null };
    case "cancelar":
      return { status: PrazoStatus.CANCELADO, resultado: decisao.motivo };
    case "descartar":
      return { status: PrazoStatus.DESCARTADO, resultado: decisao.motivo };
    case "executar":
      return agir(cliente, prazo, acao.data);
  }
}

async function agir(cliente: ChatwootClient, prazo: Prazo, acao: AcaoDoPrazo): Promise<Fim> {
  const conversaId = prazo.chatwootConversationId;

  switch (acao.tipo) {
    case "reatribuir": {
      const achado = resolverAtendente(acao.atendente, await cliente.listarAtendentes());
      const antes = prazo.donoNome ?? "a pessoa atribuída";

      if (achado.tipo !== "achado") {
        await notaInterna(
          cliente,
          conversaId,
          `⏱️ Ninguém da equipe respondeu em ${prazo.minutos} min desde a atribuição a ${antes}, mas não achei "${acao.atendente}" na equipe do Chatwoot — a conversa continua com ${antes}.`,
        );
        return {
          status: PrazoStatus.FALHOU,
          resultado: `"${acao.atendente}" não encontrado na equipe`,
        };
      }

      const nome = achado.atendente.name?.trim() || acao.atendente;
      await cliente.atribuir(conversaId, { assigneeId: achado.atendente.id });
      await notaInterna(
        cliente,
        conversaId,
        [
          `⏱️ Ninguém da equipe respondeu em ${prazo.minutos} min desde a atribuição a ${antes}. Conversa reatribuída para ${nome}.`,
          `Motivo registrado pelo agente: ${prazo.motivo}`,
        ].join("\n"),
      );
      await entregarAoHumano(conversaId, `prazo vencido: reatribuída a ${nome}`);
      return { status: PrazoStatus.EXECUTADO, resultado: `reatribuída a ${nome}` };
    }

    case "mensagem": {
      await cliente.enviarMensagem(conversaId, acao.texto.trim());
      await notaInterna(
        cliente,
        conversaId,
        `⏱️ Cliente sem responder há ${prazo.minutos} min: mensagem de retomada enviada. Motivo: ${prazo.motivo}`,
      );
      return { status: PrazoStatus.EXECUTADO, resultado: "mensagem de retomada enviada" };
    }

    case "atribuir": {
      const achado = resolverAtendente(acao.atendente, await cliente.listarAtendentes());
      if (achado.tipo !== "achado") {
        await notaInterna(
          cliente,
          conversaId,
          `⏱️ Cliente sem responder há ${prazo.minutos} min, mas não achei "${acao.atendente}" na equipe do Chatwoot — ninguém foi atribuído.`,
        );
        return {
          status: PrazoStatus.FALHOU,
          resultado: `"${acao.atendente}" não encontrado na equipe`,
        };
      }

      const nome = achado.atendente.name?.trim() || acao.atendente;
      // Mesma ordem de `atribuir_para_atendente`: nota, aviso, abrir, atribuir.
      // O aviso sai ANTES de atribuir — com dono, a regra global cala o bot.
      await notaInterna(
        cliente,
        conversaId,
        [
          `⏱️ Cliente sem responder há ${prazo.minutos} min. Atribuído a ${nome}.`,
          `Motivo registrado pelo agente: ${prazo.motivo}`,
        ].join("\n"),
      );
      await cliente.enviarMensagem(conversaId, acao.aviso.trim());
      await cliente.alternarStatus(conversaId, "open");
      await cliente.atribuir(conversaId, { assigneeId: achado.atendente.id });
      await entregarAoHumano(
        conversaId,
        `prazo vencido: cliente sem responder, atribuída a ${nome}`,
      );
      return { status: PrazoStatus.EXECUTADO, resultado: `atribuída a ${nome}` };
    }
  }
}

/** Nota que falha não desfaz o que já foi feito: registra no log e segue. */
async function notaInterna(cliente: ChatwootClient, conversaId: number, texto: string) {
  try {
    await cliente.enviarMensagem(conversaId, texto, { privado: true });
  } catch (erro) {
    logger.warn({ conversa: conversaId, erro }, "prazo: nota interna não foi gravada");
  }
}
