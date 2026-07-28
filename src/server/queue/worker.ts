import { Worker, type Job } from "bullmq";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getRedis } from "./conexao";
import { FILA_ATENDIMENTO, type JobAtendimento } from "./atendimento";
import { executarAgente } from "@/server/agents/runner";
import { clienteDoAgente } from "@/server/integrations/chatwoot/credenciais";
import { montarContexto } from "@/server/integrations/chatwoot/historico";
import { ConversationStatus, RunSource } from "@/generated/prisma/enums";

/**
 * Processa um atendimento: relê a conversa no Chatwoot, roda o agente e
 * responde.
 *
 * O histórico vem do Chatwoot, não do nosso banco — assim o agente enxerga
 * também o que humanos escreveram na conversa, e as mensagens agrupadas pelo
 * debounce chegam juntas sem lógica extra.
 */
export async function processarAtendimento(job: Job<JobAtendimento>) {
  const { chatwootConversationId, agentId } = job.data;
  const log = logger.child({ conversa: chatwootConversationId, agentId });

  const conversa = await db.conversation.findUnique({
    where: { chatwootConversationId },
  });

  // Reconferência depois do debounce: durante a espera um humano pode ter
  // assumido a conversa.
  if (conversa && conversa.status !== ConversationStatus.BOT) {
    log.info({ status: conversa.status }, "conversa não é mais do bot — ignorando");
    return;
  }

  const agente = await db.agent.findUnique({ where: { id: agentId } });
  if (!agente?.active) {
    log.info("agente desligado — ignorando");
    return;
  }

  const cliente = await clienteDoAgente(agentId);
  if (!cliente) {
    throw new Error("Bot do Chatwoot não configurado para este agente.");
  }

  const mensagens = await cliente.listarMensagens(chatwootConversationId);
  const contexto = montarContexto(mensagens);

  if (!contexto) {
    log.info("nada novo do cliente para responder");
    return;
  }

  const resultado = await executarAgente({
    agentId,
    source: RunSource.CHATWOOT,
    conversationId: conversa?.id,
    chatwootConversationId,
    historico: contexto.historico,
    mensagem: contexto.mensagem,
  });

  const resposta = resultado.resposta.trim();

  // A tool de transferência já muda o status; se transferiu e não sobrou texto,
  // não force uma resposta vazia.
  if (!resposta) {
    log.warn({ runId: resultado.runId }, "agente não produziu texto");
    return;
  }

  await cliente.enviarMensagem(chatwootConversationId, resposta);

  await db.conversation.updateMany({
    where: { chatwootConversationId },
    data: { lastMessageAt: new Date() },
  });

  log.info(
    {
      runId: resultado.runId,
      latenciaMs: resultado.latenciaMs,
      custoUsd: resultado.custoUsd,
      tools: resultado.toolCalls.length,
    },
    "resposta enviada",
  );
}

export function iniciarWorker() {
  const worker = new Worker<JobAtendimento>(
    FILA_ATENDIMENTO,
    processarAtendimento,
    {
      connection: getRedis(),
      // Atendimento é I/O quase puro (LLM + HTTP). Um pouco de paralelismo
      // ajuda; muito só arrisca estourar rate limit da OpenRouter.
      concurrency: 4,
    },
  );

  worker.on("failed", (job, erro) => {
    logger.error(
      { jobId: job?.id, tentativa: job?.attemptsMade, erro: erro.message },
      "atendimento falhou",
    );
  });

  worker.on("completed", (job) => {
    logger.debug({ jobId: job.id }, "atendimento concluído");
  });

  logger.info("worker de atendimento no ar");
  return worker;
}
