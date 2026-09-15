import type { Job } from "bullmq";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { executarAgente } from "@/server/agents/runner";
import { ehInterrupcao } from "@/server/agents/cancelamento";
import { RunSource } from "@/generated/prisma/enums";
import { clienteDeLeitura } from "@/server/integrations/chatwoot/credenciais";
import {
  mensagemDaConversaEncerrada,
  montarTranscricao,
  quemAtendeu,
  recortarAtendimento,
} from "@/server/conversa-encerrada/ciclo";
import {
  lerAtendimento,
  registrarDesfecho,
} from "@/server/conversa-encerrada/leitura";
import type { JobConversaEncerrada } from "./conversa-encerrada";

/**
 * Executa um gatilho de conversa: uma conversa foi resolvida no Chatwoot e o
 * agente trabalha sobre a transcrição do atendimento, em segundo plano.
 *
 * Nada vai para o cliente e o agente não recebe ferramenta de canal
 * (`contexto.ts`). O que ele fizer, faz pelas ferramentas ligadas — no caso da
 * avaliação de atendimento, busca a task e grava a nota no CRM.
 */
export async function processarConversaEncerrada(job: Job<JobConversaEncerrada>) {
  const dados = job.data;
  const log = logger.child({
    gatilhoId: dados.gatilhoId,
    conversa: dados.chatwootConversationId,
  });

  const gatilho = await db.gatilhoDeConversa.findUnique({
    where: { id: dados.gatilhoId },
    include: { agent: { select: { active: true, archivedAt: true } } },
  });

  // Reconferência: o gatilho ou o agente podem ter sido desligados entre a
  // chegada da resolução e a execução.
  if (!gatilho?.enabled || !gatilho.agent.active || gatilho.agent.archivedAt) {
    await registrarDesfecho(dados, "ignorado", "gatilho ou agente foi desligado antes da execução");
    return;
  }

  const leitura = await clienteDeLeitura();
  if (!leitura) {
    // Configuração, não instabilidade: tentar de novo não resolve.
    await registrarDesfecho(
      dados,
      "falhou",
      "sem token de leitura do Chatwoot — configure em Integrações → Chatwoot",
    );
    return;
  }

  let atendimento: Awaited<ReturnType<typeof lerAtendimento>>;
  try {
    atendimento = await lerAtendimento(
      leitura.cliente,
      dados.chatwootConversationId,
      (mensagens) => recortarAtendimento(mensagens, dados.resolvidaEm),
    );
  } catch (erro) {
    // Nada foi feito ainda: seguro para o BullMQ tentar de novo.
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await registrarDesfecho(dados, "falhou", `não consegui ler a conversa: ${mensagem}`);
    throw erro;
  }

  // Conferido aqui, antes do modelo: conversa que só teve robô, nota interna
  // ou automação não custa nada.
  const atendentes = quemAtendeu(atendimento.mensagens, gatilho.contasDeAutomacao);
  if (gatilho.exigeAtendimentoHumano && atendentes.length === 0) {
    await registrarDesfecho(
      dados,
      "ignorado",
      "nenhuma pessoa da equipe respondeu ao cliente neste atendimento",
    );
    return;
  }

  const conversa = await db.conversation.findUnique({
    where: { chatwootConversationId: dados.chatwootConversationId },
    select: { id: true },
  });

  try {
    const resultado = await executarAgente({
      agentId: gatilho.agentId,
      source: RunSource.CONVERSA_ENCERRADA,
      conversationId: conversa?.id,
      chatwootConversationId: dados.chatwootConversationId,
      inboxId: dados.inboxId,
      mensagem: mensagemDaConversaEncerrada({
        conversationId: dados.chatwootConversationId,
        link: `${leitura.config.baseUrl}/app/accounts/${leitura.config.accountId}/conversations/${dados.chatwootConversationId}`,
        resolvidaEm: dados.resolvidaEm,
        contatoNome: dados.contatoNome,
        telefone: dados.telefone,
        atendentes,
        transcricao: montarTranscricao(
          atendimento.mensagens,
          gatilho.contasDeAutomacao,
          atendimento.completa,
        ),
      }),
    });

    await registrarDesfecho(
      dados,
      "executado",
      `run ${resultado.runId} · ${resultado.toolCalls.length} tool(s) · ${resultado.iteracoes} iteração(ões)`,
    );
  } catch (erro) {
    // Parada pedida no painel encerra aqui: relançar faria o BullMQ rodar o
    // turno inteiro de novo, tools e tudo.
    if (ehInterrupcao(erro)) {
      await registrarDesfecho(dados, "interrompido", erro.message);
      return;
    }

    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await registrarDesfecho(dados, "falhou", mensagem);

    const runId = (erro as { runId?: string } | undefined)?.runId;
    const jaExecutouTool = runId
      ? (await db.toolCall.count({ where: { runId } })) > 0
      : false;

    if (jaExecutouTool) {
      // Mesma regra do gatilho HTTP e do agendamento: uma tool que já rodou
      // pode ter gravado a nota ou o comentário no CRM — de novo seria dobrado.
      log.error({}, "gatilho de conversa falhou depois de executar tool — sem nova tentativa");
      return;
    }

    log.error({ erro: mensagem }, "gatilho de conversa falhou antes de qualquer tool — tentando de novo");
    throw erro;
  }
}
