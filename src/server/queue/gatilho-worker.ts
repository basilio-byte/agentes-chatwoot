import type { Job } from "bullmq";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { executarAgente } from "@/server/agents/runner";
import { ehInterrupcao } from "@/server/agents/cancelamento";
import { RunSource } from "@/generated/prisma/enums";
import { montarMensagemDoGatilho } from "@/server/gatilho/payload";
import type { JobGatilho } from "./gatilho";

/**
 * Processa um gatilho HTTP externo — separado de `worker.ts` (que já tem
 * lógica extensa e específica de Chatwoot: routing, handoff, regras globais,
 * relógio de espera) de propósito, para não misturar os dois domínios.
 *
 * Sem conversa, sem transferência entre agentes, sem canal de resposta: o
 * agente só age através das tools que tiver ligadas. `resultado.handoff`, se
 * o modelo tentar transferir mesmo assim, é simplesmente ignorado aqui — não
 * precisa de trava nova, só de não iterar sobre ele.
 */
export async function processarGatilho(job: Job<JobGatilho>) {
  const { agentId, webhookEventId, payload, eventType } = job.data;
  const log = logger.child({ agentId, webhookEventId, eventType });

  const [trigger, agente] = await Promise.all([
    db.agentTrigger.findUnique({ where: { agentId } }),
    db.agent.findUnique({
      where: { id: agentId },
      select: { active: true, archivedAt: true },
    }),
  ]);

  // Reconferência: o gatilho ou o agente podem ter sido desligados entre o
  // accept (rota) e a execução deste job.
  if (!trigger?.enabled || !agente?.active || agente.archivedAt) {
    await marcarEntregaGatilho(
      webhookEventId,
      "ignorado",
      "gatilho ou agente foi desligado antes da execução",
    );
    return;
  }

  try {
    const resultado = await executarAgente({
      agentId,
      source: RunSource.TRIGGER,
      mensagem: montarMensagemDoGatilho({ eventType, payload }),
    });

    await marcarEntregaGatilho(
      webhookEventId,
      "executado",
      `run ${resultado.runId} · ${resultado.toolCalls.length} tool(s) · ${resultado.iteracoes} iteração(ões)`,
    );
  } catch (erro) {
    // Parada pedida no painel encerra aqui: relançar faria o BullMQ rodar o
    // turno inteiro de novo, tools e tudo.
    if (ehInterrupcao(erro)) {
      await marcarEntregaGatilho(webhookEventId, "interrompido", erro.message);
      return;
    }

    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await marcarEntregaGatilho(webhookEventId, "falhou", mensagem);

    const runId = (erro as { runId?: string } | undefined)?.runId;
    const jaExecutouTool = runId
      ? (await db.toolCall.count({ where: { runId } })) > 0
      : false;

    if (jaExecutouTool) {
      // Mesmo princípio já corrigido para o Chatwoot nesta sessão: o BullMQ
      // reexecuta o job INTEIRO em retry, e uma tool já rodou de verdade num
      // sistema externo (comentário duplicado, tarefa alterada duas vezes).
      // Falha DEPOIS de efeito colateral não pode virar nova tentativa.
      log.error(
        {},
        "gatilho falhou depois de executar tool — sem nova tentativa, para não duplicar a ação",
      );
      return;
    }

    log.error({ erro: mensagem }, "gatilho falhou antes de qualquer tool — tentando de novo");
    throw erro; // falha ANTES de qualquer efeito colateral — seguro para o BullMQ tentar de novo
  }
}

/** Marca o desfecho de uma entrega já registrada. Melhor esforço. */
async function marcarEntregaGatilho(
  webhookEventId: string,
  resultado: string,
  detalhe: string,
) {
  try {
    await db.webhookEvent.update({
      where: { id: webhookEventId },
      data: { processedAt: new Date(), resultado, detalhe },
    });
  } catch (erro) {
    logger.warn(
      { webhookEventId, erro },
      "não consegui marcar o desfecho da entrega do gatilho",
    );
  }
}
