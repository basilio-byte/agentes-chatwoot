import type { Job } from "bullmq";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { executarAgente } from "@/server/agents/runner";
import { ehInterrupcao } from "@/server/agents/cancelamento";
import { RunSource } from "@/generated/prisma/enums";
import { clienteDeLeitura } from "@/server/integrations/chatwoot/credenciais";
import type { ChatwootClient } from "@/server/integrations/chatwoot/client";
import {
  mensagemDaConversaEncerrada,
  montarTranscricao,
  quemAtendeu,
  recortarAtendimento,
  type MensagemDoCiclo,
} from "@/server/conversa-encerrada/ciclo";
import type { JobConversaEncerrada } from "./conversa-encerrada";

/**
 * Páginas lidas para trás procurando o começo do atendimento. A API devolve 20
 * mensagens por página: são até 300, e acima disso a transcrição avisa que o
 * começo ficou de fora.
 */
export const PAGINAS_MAXIMAS = 15;

type Desfecho = "executado" | "ignorado" | "falhou" | "interrompido";

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
    await encerrar(dados, "ignorado", "gatilho ou agente foi desligado antes da execução");
    return;
  }

  const leitura = await clienteDeLeitura();
  if (!leitura) {
    // Configuração, não instabilidade: tentar de novo não resolve.
    await encerrar(
      dados,
      "falhou",
      "sem token de leitura do Chatwoot — configure em Integrações → Chatwoot",
    );
    return;
  }

  let atendimento: { mensagens: MensagemDoCiclo[]; completa: boolean };
  try {
    atendimento = await lerAtendimento(
      leitura.cliente,
      dados.chatwootConversationId,
      dados.resolvidaEm,
    );
  } catch (erro) {
    // Nada foi feito ainda: seguro para o BullMQ tentar de novo.
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await encerrar(dados, "falhou", `não consegui ler a conversa: ${mensagem}`);
    throw erro;
  }

  // Conferido aqui, antes do modelo: conversa que só teve robô, nota interna
  // ou automação não custa nada.
  const atendentes = quemAtendeu(atendimento.mensagens, gatilho.contasDeAutomacao);
  if (gatilho.exigeAtendimentoHumano && atendentes.length === 0) {
    await encerrar(
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

    await encerrar(
      dados,
      "executado",
      `run ${resultado.runId} · ${resultado.toolCalls.length} tool(s) · ${resultado.iteracoes} iteração(ões)`,
    );
  } catch (erro) {
    // Parada pedida no painel encerra aqui: relançar faria o BullMQ rodar o
    // turno inteiro de novo, tools e tudo.
    if (ehInterrupcao(erro)) {
      await encerrar(dados, "interrompido", erro.message);
      return;
    }

    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await encerrar(dados, "falhou", mensagem);

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

/**
 * O atendimento inteiro, paginando para trás até a resolução anterior.
 *
 * `completa` falso quer dizer que as páginas acabaram antes do começo — só
 * acontece em conversa muito longa, e a transcrição avisa.
 */
async function lerAtendimento(
  cliente: ChatwootClient,
  conversationId: number,
  resolvidaEm: number,
): Promise<{ mensagens: MensagemDoCiclo[]; completa: boolean }> {
  const lidas: MensagemDoCiclo[] = [];
  let antesDe: number | undefined;

  for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina++) {
    const lote = await cliente.listarMensagensAntes(conversationId, antesDe);
    if (lote.length === 0) {
      // Chegou ao começo da conversa: é o primeiro atendimento dela.
      return { mensagens: recortarAtendimento(lidas, resolvidaEm).mensagens, completa: true };
    }

    lidas.push(...lote);
    const recorte = recortarAtendimento(lidas, resolvidaEm);
    if (recorte.achouOInicio) return { mensagens: recorte.mensagens, completa: true };

    antesDe = Math.min(...lote.map((m) => m.id));
  }

  const recorte = recortarAtendimento(lidas, resolvidaEm);
  return { mensagens: recorte.mensagens, completa: recorte.achouOInicio };
}

/** Grava o desfecho na linha do gatilho (o que a tela mostra) e na entrega. */
async function encerrar(
  dados: JobConversaEncerrada,
  resultado: Desfecho,
  detalhe: string,
) {
  const curto = detalhe.slice(0, 500);

  try {
    await db.gatilhoDeConversa.update({
      where: { id: dados.gatilhoId },
      data: {
        ultimaExecucaoEm: new Date(),
        ultimoResultado: resultado,
        ultimoDetalhe: curto,
      },
    });
  } catch (erro) {
    logger.warn({ gatilhoId: dados.gatilhoId, erro }, "não consegui gravar o desfecho do gatilho de conversa");
  }

  try {
    await db.webhookEvent.update({
      where: { id: dados.webhookEventId },
      data: { processedAt: new Date(), resultado, detalhe: curto },
    });
  } catch (erro) {
    logger.warn(
      { webhookEventId: dados.webhookEventId, erro },
      "não consegui marcar a entrega do gatilho de conversa",
    );
  }
}
