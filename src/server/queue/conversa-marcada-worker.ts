import type { Job } from "bullmq";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { executarAgente } from "@/server/agents/runner";
import { ehInterrupcao } from "@/server/agents/cancelamento";
import { ehSemCredito, MOTIVO_SEM_CREDITO } from "@/server/agents/sem-credito";
import { RunSource } from "@/generated/prisma/enums";
import {
  clienteDeLeitura,
  clienteDoAgente,
} from "@/server/integrations/chatwoot/credenciais";
import type { ChatwootClient } from "@/server/integrations/chatwoot/client";
import { humanidadeDoDono } from "@/server/integrations/chatwoot/regras";
import { montarTranscricao, quemAtendeu } from "@/server/conversa-encerrada/ciclo";
import {
  lerAtendimento,
  registrarDesfecho,
} from "@/server/conversa-encerrada/leitura";
import { recortarAtendimentoAtual } from "@/server/conversa-marcada/recorte";
import {
  DIAS_DE_REGISTRO,
  mensagemDaConversaMarcada,
  notaJaRegistrada,
  notaSemDono,
  tasksRegistradas,
} from "@/server/conversa-marcada/mensagem";
import type { JobConversaMarcada } from "./conversa-marcada";

/**
 * Executa um gatilho de checkbox: alguém da equipe marcou um campo numa conversa
 * do Chatwoot, e o agente trabalha sobre o atendimento atual, em segundo plano —
 * a passagem manual para os CRMs que o n8n fazia (15/09/2026).
 *
 * A ordem é a das decisões do usuário, e cada passo antes do modelo existe para
 * não gastar nem registrar à toa:
 *  1. desmarca o checkbox, lendo e mesclando os atributos da conversa;
 *  2. sem pessoa dona da conversa, não roda — nota pedindo para atribuir;
 *  3. este agente já criou task nesta conversa há pouco: não roda — nota com o link;
 *  4. só então lê o atendimento e chama o agente.
 */
export async function processarConversaMarcada(job: Job<JobConversaMarcada>) {
  const dados = job.data;
  const log = logger.child({
    gatilhoId: dados.gatilhoId,
    conversa: dados.chatwootConversationId,
    atributo: dados.atributo,
  });

  const gatilho = await db.gatilhoDeConversa.findUnique({
    where: { id: dados.gatilhoId },
    include: { agent: { select: { name: true, active: true, archivedAt: true } } },
  });

  // Reconferência: desligado, ou o checkbox saiu da configuração, entre a
  // marcação e a execução. Aí nem o checkbox é tocado — quem desligou pode
  // estar tratando a conversa de outro jeito.
  if (
    !gatilho?.enabled ||
    !gatilho.atributos.includes(dados.atributo) ||
    !gatilho.agent.active ||
    gatilho.agent.archivedAt
  ) {
    await registrarDesfecho(dados, "ignorado", "gatilho ou agente foi desligado antes da execução");
    return;
  }

  // Token de usuário, para ler E para desmarcar: o do bot não lê, e caixa sem o
  // nosso robô não teria com que escrever o atributo.
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

  const avisos: string[] = [];

  // 1. Desmarca na hora. Falhar aqui não impede o registro: o pior caso é o
  // checkbox continuar marcado, e isso fica escrito no detalhe da entrega.
  try {
    await leitura.cliente.definirAtributosDaConversa(dados.chatwootConversationId, {
      [dados.atributo]: null,
    });
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    log.warn({ erro: mensagem }, "não consegui desmarcar o checkbox");
    avisos.push(`checkbox não desmarcado: ${mensagem}`);
  }

  let estado: Awaited<ReturnType<ChatwootClient["obterConversa"]>>;
  try {
    estado = await leitura.cliente.obterConversa(dados.chatwootConversationId);
  } catch (erro) {
    // Nada foi registrado ainda: seguro para o BullMQ tentar de novo.
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await registrarDesfecho(dados, "falhou", `não consegui ler a conversa: ${mensagem}`);
    throw erro;
  }

  const conversa = await db.conversation.findUnique({
    where: { chatwootConversationId: dados.chatwootConversationId },
    select: { id: true, portaAgentId: true },
  });
  // As notas saem pelo robô da caixa, como as do atendimento — e é a mesma
  // porta que o turno recebe, porque os agentes internos não têm bot próprio.
  const portaId = conversa?.portaAgentId ?? null;

  // 2. O dono da conversa é quem entra no registro. Robô dono conta como ninguém.
  const donoEhPessoa =
    estado.assigneeId != null && humanidadeDoDono(estado.assigneeTipo) === true;
  if (!donoEhPessoa) {
    const notada = await deixarNota(
      portaId,
      dados.chatwootConversationId,
      notaSemDono({ atributo: dados.atributo, agente: gatilho.agent.name }),
    );
    await registrarDesfecho(
      dados,
      "ignorado",
      juntar(["conversa sem pessoa responsável", rastroDaNota(notada), ...avisos]),
    );
    return;
  }

  // 3. Registro que este agente já fez nesta conversa. Lido das execuções, sem
  // modelo: é o caso da 10912, em que o CRM tinha criado a task de manhã e o
  // checkbox da tarde tentou outra.
  if (conversa) {
    const registradas = tasksRegistradas(
      await db.toolCall.findMany({
        where: {
          toolName: "clickup_criar_tarefa",
          isError: false,
          createdAt: { gte: new Date(Date.now() - DIAS_DE_REGISTRO * 24 * 60 * 60 * 1000) },
          run: { agentId: gatilho.agentId, conversationId: conversa.id },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { output: true, createdAt: true },
      }),
    );

    if (registradas.length > 0) {
      const notada = await deixarNota(
        portaId,
        dados.chatwootConversationId,
        notaJaRegistrada({
          atributo: dados.atributo,
          agente: gatilho.agent.name,
          tasks: registradas,
        }),
      );
      await registrarDesfecho(
        dados,
        "ignorado",
        juntar([
          `task já registrada nesta conversa: ${registradas[0].url ?? registradas[0].nome ?? "sem link"}`,
          rastroDaNota(notada),
          ...avisos,
        ]),
      );
      return;
    }
  }

  // 4. O atendimento, e o agente.
  let atendimento: Awaited<ReturnType<typeof lerAtendimento>>;
  try {
    atendimento = await lerAtendimento(
      leitura.cliente,
      dados.chatwootConversationId,
      (mensagens) => recortarAtendimentoAtual(mensagens, dados.marcadoEm),
    );
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await registrarDesfecho(dados, "falhou", `não consegui ler a conversa: ${mensagem}`);
    throw erro;
  }

  try {
    const resultado = await executarAgente({
      agentId: gatilho.agentId,
      source: RunSource.CONVERSA_MARCADA,
      conversationId: conversa?.id,
      chatwootConversationId: dados.chatwootConversationId,
      inboxId: dados.inboxId,
      canalAgentId: portaId ?? undefined,
      mensagem: mensagemDaConversaMarcada({
        atributo: dados.atributo,
        conversationId: dados.chatwootConversationId,
        link: `${leitura.config.baseUrl}/app/accounts/${leitura.config.accountId}/conversations/${dados.chatwootConversationId}`,
        marcadoEm: dados.marcadoEm,
        contatoNome: dados.contatoNome,
        telefone: dados.telefone,
        dono: estado.assigneeNome,
        atendentes: quemAtendeu(atendimento.mensagens, gatilho.contasDeAutomacao),
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
      juntar([
        `run ${resultado.runId} · ${resultado.toolCalls.length} tool(s) · ${resultado.iteracoes} iteração(ões)`,
        ...avisos,
      ]),
    );
  } catch (erro) {
    // Parada pedida no painel encerra aqui: relançar faria o BullMQ rodar o
    // turno inteiro de novo, tools e tudo.
    if (ehInterrupcao(erro)) {
      await registrarDesfecho(dados, "interrompido", erro.message);
      return;
    }

    // Falta de saldo: repetir não repõe crédito, e o BullMQ rodaria o turno
    // inteiro de novo. Fica escrito na entrega, junto do que já foi feito
    // nesta conversa (desmarcar o checkbox, por exemplo).
    if (ehSemCredito(erro)) {
      await registrarDesfecho(dados, "falhou", juntar([MOTIVO_SEM_CREDITO, ...avisos]));
      return;
    }

    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await registrarDesfecho(dados, "falhou", juntar([mensagem, ...avisos]));

    const runId = (erro as { runId?: string } | undefined)?.runId;
    const jaExecutouTool = runId
      ? (await db.toolCall.count({ where: { runId } })) > 0
      : false;

    if (jaExecutouTool) {
      // A task pode já estar no CRM: de novo seria task em dobro.
      log.error({}, "gatilho de checkbox falhou depois de executar tool — sem nova tentativa");
      return;
    }

    log.error({ erro: mensagem }, "gatilho de checkbox falhou antes de qualquer tool — tentando de novo");
    throw erro;
  }
}

/**
 * Nota interna pelo robô da caixa. Nunca lança: a nota é aviso, e falhar nela
 * não pode transformar um "não roda" em erro que o BullMQ repetiria.
 */
async function deixarNota(
  portaId: string | null,
  conversa: number,
  texto: string,
): Promise<boolean> {
  if (!portaId) return false;

  try {
    const cliente = await clienteDoAgente(portaId);
    if (!cliente) return false;
    await cliente.enviarMensagem(conversa, texto, { privado: true });
    return true;
  } catch (erro) {
    logger.warn({ portaId, conversa, erro }, "não consegui deixar a nota do checkbox");
    return false;
  }
}

function rastroDaNota(notada: boolean) {
  return notada ? "nota interna deixada" : "sem robô nesta caixa para deixar nota";
}

function juntar(partes: string[]) {
  return partes.filter(Boolean).join(" · ");
}
