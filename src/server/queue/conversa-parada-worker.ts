import type { Job } from "bullmq";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { executarAgente } from "@/server/agents/runner";
import { ehInterrupcao } from "@/server/agents/cancelamento";
import { ehSemCredito, MOTIVO_SEM_CREDITO } from "@/server/agents/sem-credito";
import { EventoDeConversa, RunSource } from "@/generated/prisma/enums";
import { clienteDeLeitura } from "@/server/integrations/chatwoot/credenciais";
import { montarTranscricao, quemAtendeu } from "@/server/conversa-encerrada/ciclo";
import { lerAtendimento, registrarDesfecho } from "@/server/conversa-encerrada/leitura";
import { recortarAtendimentoAtual } from "@/server/conversa-marcada/recorte";
import { mensagemDaConversaParada } from "@/server/conversa-parada/mensagem";
import { vereditoDaConversa } from "@/server/conversa-parada/elegibilidade";
import { portaDaCaixa } from "@/server/integrations/chatwoot/porta";
import {
  resumirRodada,
  varrerConversasParadas,
} from "@/server/conversa-parada/varrer";
import type { JobConversaParada, JobVarredura } from "./conversa-parada";

/**
 * A varredura do relógio: lista as conversas abertas da caixa e enfileira as
 * paradas. Não chama modelo nenhum.
 */
export async function processarVarredura(job: Job<JobVarredura>) {
  const { gatilhoId } = job.data;
  const log = logger.child({ gatilhoId });

  const gatilho = await db.gatilhoDeConversa.findUnique({
    where: { id: gatilhoId },
    include: {
      agent: {
        select: {
          active: true,
          archivedAt: true,
          inboxMode: true,
          inboxIds: true,
        },
      },
    },
  });

  // Reconferência: desligar vale também para o que já está no relógio, e o
  // varredor só sai do Redis na próxima reconciliação.
  if (
    !gatilho?.enabled ||
    gatilho.evento !== EventoDeConversa.SEM_RESPOSTA ||
    !gatilho.agent.active ||
    gatilho.agent.archivedAt
  ) {
    log.info({}, "varredura ignorada: gatilho ou agente desligado");
    return;
  }

  const leitura = await clienteDeLeitura();
  if (!leitura) {
    // Configuração, não instabilidade: tentar de novo não resolve.
    await gravarResumo(gatilhoId, "falhou", "sem token de leitura do Chatwoot — configure em Integrações → Chatwoot");
    return;
  }

  // O escopo é o do agente (`Agent.inboxMode`), o mesmo da aba Canal. Lista
  // vazia ou modo "todas" varre a conta inteira, como `atendeInbox` resolve.
  const caixas =
    gatilho.agent.inboxMode === "specific" ? (gatilho.agent.inboxIds ?? []) : [];

  try {
    const resumo = await varrerConversasParadas({
      gatilho: {
        id: gatilho.id,
        agentId: gatilho.agentId,
        horasParadas: gatilho.horasParadas,
        tetoPorRodada: gatilho.tetoPorRodada,
        contasDeAutomacao: gatilho.contasDeAutomacao,
      },
      cliente: leitura.cliente,
      caixas,
    });

    await gravarResumo(gatilhoId, "executado", resumirRodada(resumo));
    log.info(resumo, "varredura de conversas paradas concluída");
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await gravarResumo(gatilhoId, "falhou", mensagem);
    // Nenhuma execução paga acontece aqui: é seguro o BullMQ tentar de novo.
    throw erro;
  }
}

/**
 * Uma conversa parada: lê o atendimento e chama o agente, que escreve a nota
 * interna para quem está com ela.
 *
 * ⚠ Reconfere a elegibilidade AO VIVO antes de gastar o modelo. Entre a
 * varredura e aqui podem ter passado minutos, e qualquer um dos três motivos de
 * desistir pode ter acontecido: o cliente escreveu, alguém da equipe respondeu,
 * ou a conversa mudou de mãos. Comentar depois disso é falar de um atendimento
 * que já andou.
 */
export async function processarConversaParada(job: Job<JobConversaParada>) {
  const dados = job.data;
  const log = logger.child({
    gatilhoId: dados.gatilhoId,
    conversa: dados.chatwootConversationId,
  });

  const gatilho = await db.gatilhoDeConversa.findUnique({
    where: { id: dados.gatilhoId },
    include: { agent: { select: { name: true, active: true, archivedAt: true } } },
  });

  if (
    !gatilho?.enabled ||
    gatilho.evento !== EventoDeConversa.SEM_RESPOSTA ||
    !gatilho.agent.active ||
    gatilho.agent.archivedAt
  ) {
    await registrarDesfecho(dados, "ignorado", "gatilho ou agente foi desligado antes da execução");
    return;
  }

  const leitura = await clienteDeLeitura();
  if (!leitura) {
    await registrarDesfecho(dados, "falhou", "sem token de leitura do Chatwoot");
    return;
  }

  let estado: Awaited<ReturnType<typeof leitura.cliente.obterConversa>>;
  let atendimento: Awaited<ReturnType<typeof lerAtendimento>>;
  try {
    estado = await leitura.cliente.obterConversa(dados.chatwootConversationId);
    atendimento = await lerAtendimento(
      leitura.cliente,
      dados.chatwootConversationId,
      (mensagens) => recortarAtendimentoAtual(mensagens, Math.floor(Date.now() / 1000)),
    );
  } catch (erro) {
    // Nada foi escrito ainda: seguro para o BullMQ tentar de novo.
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await registrarDesfecho(dados, "falhou", `não consegui ler a conversa: ${mensagem}`);
    throw erro;
  }

  const veredito = vereditoDaConversa({
    conversa: {
      id: dados.chatwootConversationId,
      status: estado.status,
      assigneeId: estado.assigneeId,
      assigneeTipo: estado.assigneeTipo,
      ultimaMensagem: null,
    },
    mensagens: atendimento.mensagens,
    horasParadas: gatilho.horasParadas,
    agoraEmSegundos: Math.floor(Date.now() / 1000),
    contasDeAutomacao: gatilho.contasDeAutomacao,
  });

  if (!veredito.entra) {
    await registrarDesfecho(dados, "ignorado", `mudou antes da análise: ${veredito.motivo}`);
    return;
  }

  // A nota sai pelo robô da caixa, como as do atendimento — o agente comercial
  // não tem bot próprio, e sem a porta `registrar_nota_interna` falharia.
  const conversa = await db.conversation.findUnique({
    where: { chatwootConversationId: dados.chatwootConversationId },
    select: { id: true, portaAgentId: true },
  });
  const portaId = await portaDaCaixa(dados.chatwootConversationId, dados.inboxId);

  if (!portaId) {
    await registrarDesfecho(
      dados,
      "ignorado",
      "nenhum agente com bot nesta caixa — não há por onde escrever a nota interna",
    );
    return;
  }

  try {
    const resultado = await executarAgente({
      agentId: gatilho.agentId,
      source: RunSource.CONVERSA_PARADA,
      conversationId: conversa?.id,
      chatwootConversationId: dados.chatwootConversationId,
      inboxId: dados.inboxId,
      canalAgentId: portaId,
      mensagem: mensagemDaConversaParada({
        conversationId: dados.chatwootConversationId,
        link: `${leitura.config.baseUrl}/app/accounts/${leitura.config.accountId}/conversations/${dados.chatwootConversationId}`,
        contatoNome: dados.contatoNome,
        telefone: dados.telefone,
        dono: estado.assigneeNome ?? dados.dono,
        atendentes: quemAtendeu(atendimento.mensagens, gatilho.contasDeAutomacao),
        ultimaMensagemEm: dados.ultimaMensagemEm,
        ultimoFalante: dados.ultimoFalante,
        horasParadas: gatilho.horasParadas,
        transcricao: montarTranscricao(
          atendimento.mensagens,
          gatilho.contasDeAutomacao,
          atendimento.completa,
        ),
      }),
    });

    const escreveu = resultado.toolCalls.some(
      (t) => t.nome === "registrar_nota_interna" && !t.isError,
    );

    // ⚠ "Executado" não quer dizer que deixou nota: no lote de 17/09/2026 o
    // fluxo do n8n produziu duas análises que o modelo escreveu como resposta e
    // nunca gravou — execução verde, ninguém leu. Aqui a diferença fica escrita.
    await registrarDesfecho(
      dados,
      "executado",
      `${escreveu ? "nota interna deixada" : "sem nota: o agente não viu o que sugerir"} · run ${resultado.runId} · ${resultado.iteracoes} iteração(ões)`,
    );
  } catch (erro) {
    if (ehInterrupcao(erro)) {
      await registrarDesfecho(dados, "interrompido", erro.message);
      return;
    }

    if (ehSemCredito(erro)) {
      await registrarDesfecho(dados, "falhou", MOTIVO_SEM_CREDITO);
      return;
    }

    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await registrarDesfecho(dados, "falhou", mensagem);

    const runId = (erro as { runId?: string } | undefined)?.runId;
    const jaExecutouTool = runId
      ? (await db.toolCall.count({ where: { runId } })) > 0
      : false;

    if (jaExecutouTool) {
      // A nota pode já estar na conversa: de novo seria nota em dobro.
      log.error({}, "conversa parada falhou depois de executar tool — sem nova tentativa");
      return;
    }

    log.error({ erro: mensagem }, "conversa parada falhou antes de qualquer tool — tentando de novo");
    throw erro;
  }
}

/**
 * O desfecho da RODADA, não o da última conversa.
 *
 * É o que a tela do gatilho mostra, e a pergunta de quem a abre é "o que
 * aconteceu com as conversas todas?".
 */
async function gravarResumo(
  gatilhoId: string,
  resultado: "executado" | "falhou",
  detalhe: string,
) {
  try {
    await db.gatilhoDeConversa.update({
      where: { id: gatilhoId },
      data: {
        ultimaExecucaoEm: new Date(),
        ultimoResultado: resultado,
        ultimoDetalhe: detalhe.slice(0, 500),
      },
    });
  } catch (erro) {
    logger.warn({ gatilhoId, erro }, "não consegui gravar o resumo da varredura");
  }
}
