import { Worker, type Job } from "bullmq";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getRedis } from "./conexao";
import { FILA_ATENDIMENTO, type JobAtendimento } from "./atendimento";
import { executarAgente } from "@/server/agents/runner";
import { clienteDoAgente } from "@/server/integrations/chatwoot/credenciais";
import { montarContexto } from "@/server/integrations/chatwoot/historico";
import { podeAgir } from "@/server/integrations/chatwoot/regras";
import { ConversationStatus, RunSource } from "@/generated/prisma/enums";

/**
 * Marca a conversa como encerrada e corta o histórico.
 *
 * O corte é o coração da regra: o mesmo cliente costuma voltar por outro
 * assunto, e arrastar o contexto anterior faria o agente responder a pergunta
 * errada. Reabriu, começa do zero.
 */
export async function marcarResolvida(chatwootConversationId: number) {
  const agora = new Date();
  await db.conversation.updateMany({
    where: { chatwootConversationId },
    data: {
      status: ConversationStatus.CLOSED,
      resolvidaEm: agora,
      historicoDesde: agora,
    },
  });
}

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

  // Estado ao vivo do Chatwoot — é o que torna as regras globais absolutas.
  // Não depende de qual webhook o Agent Bot recebe, e fecha a janela entre um
  // humano assumir a conversa e o agente enviar a resposta.
  const aoVivo = await cliente.obterConversa(chatwootConversationId);
  const veredito = podeAgir(aoVivo);

  if (!veredito.pode) {
    log.info({ motivo: veredito.motivo }, "regra global impede resposta");

    if (veredito.resolvida) {
      // Resolvida: corta o histórico. Se reabrir, começa do zero.
      await marcarResolvida(chatwootConversationId);
    } else {
      await db.conversation.updateMany({
        where: { chatwootConversationId },
        data: { status: ConversationStatus.HUMAN },
      });
    }
    return;
  }

  const mensagens = await cliente.listarMensagens(chatwootConversationId);
  const contexto = montarContexto(mensagens, conversa?.historicoDesde);

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

  // Segunda checagem, agora depois da chamada ao modelo: o humano pode ter
  // assumido justamente enquanto o agente pensava. Uma requisição a mais é
  // barata perto de o bot atropelar um atendimento.
  const antesDeEnviar = await cliente.obterConversa(chatwootConversationId);
  const aindaPode = podeAgir(antesDeEnviar);
  if (!aindaPode.pode) {
    log.info(
      { motivo: aindaPode.motivo, runId: resultado.runId },
      "estado mudou durante a geração — resposta descartada",
    );
    if (aindaPode.resolvida) await marcarResolvida(chatwootConversationId);
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
