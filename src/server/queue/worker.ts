import { Worker, type Job } from "bullmq";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getRedis } from "./conexao";
import { FILA_ATENDIMENTO, type JobAtendimento } from "./atendimento";
import { iniciarBatimento } from "./batimento";
import { iniciarLimpeza } from "./limpeza";
import { iniciarVigia } from "./vigia";
import { executarAgente } from "@/server/agents/runner";
import { clienteDoAgente } from "@/server/integrations/chatwoot/credenciais";
import type { ChatwootClient } from "@/server/integrations/chatwoot/client";
import { montarContexto } from "@/server/integrations/chatwoot/historico";
import { podeAgir, precisaAbrir } from "@/server/integrations/chatwoot/regras";
import { entregarAoHumano, marcarResolvida } from "@/server/integrations/chatwoot/resolucao";
import {
  mensagemDeBastao,
  resolverAgenteAtivo,
  type AgenteRoteavel,
} from "@/server/agents/equipe";
import {
  explicarParada,
  novoEstado,
  podeTransferir,
  registrarTransferencia,
  registrarVisita,
  type MotivoDeParada,
} from "@/server/agents/travas";
import { ConversationStatus, RunSource } from "@/generated/prisma/enums";
import type { SinalDeHandoff } from "@/server/integrations/types";

export { marcarResolvida };

/** Só o que estas funções usam do logger — evita casar a tipagem do pino. */
type Registro = {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
};

/**
 * Processa um atendimento: relê a conversa no Chatwoot, roda o agente
 * responsável e responde. Se ele passar o atendimento a um colega, o colega
 * assume **no mesmo ciclo** — o cliente recebe uma resposta, não um silêncio até
 * mandar outra mensagem.
 *
 * O histórico vem do Chatwoot, não do nosso banco — assim o agente enxerga
 * também o que humanos escreveram na conversa, e as mensagens agrupadas pelo
 * debounce chegam juntas sem lógica extra.
 */
export async function processarAtendimento(job: Job<JobAtendimento>) {
  const { chatwootConversationId } = job.data;
  try {
    await atender(job);
    // Deu certo: limpa a falha anterior para o painel não mostrar erro velho.
    await registrarFalha(chatwootConversationId, null);
  } catch (erro) {
    // Falha ANTES da chamada ao modelo não cria AgentRun — sem este registro, a
    // causa existiria só no log do container e o painel diria "ainda sem
    // resposta" para sempre.
    const motivo = erro instanceof Error ? erro.message : String(erro);
    await registrarFalha(chatwootConversationId, motivo);

    // Falha na PREPARAÇÃO (buscar a conversa, listar mensagens) acontece antes
    // do laço, então a rede de segurança de lá não roda. Nas primeiras
    // tentativas isso é certo — a próxima pode dar certo e o cliente nem
    // percebe. Na última, alguém tem de falar com ele.
    if (ultimaTentativa(job)) {
      await avisarFalhaDefinitiva(job.data.agentId, chatwootConversationId);
    }

    throw erro; // deixa o BullMQ tentar de novo
  }
}

/**
 * O BullMQ conta a partir de zero; `attempts` é o total permitido.
 *
 * Sem essa informação, trata como tentativa única — avisar o cliente cedo
 * demais é melhor que nunca avisar.
 */
function ultimaTentativa(job: Job<JobAtendimento>): boolean {
  const total = job.opts?.attempts ?? 1;
  return (job.attemptsMade ?? 0) + 1 >= total;
}

/**
 * Última palavra ao cliente quando o atendimento não foi nem começado.
 *
 * Melhor esforço, e sem marcar a conversa como humana: o vigia cuida disso se
 * ninguém aparecer, e aqui a intenção é só não deixar a pessoa no vácuo.
 */
async function avisarFalhaDefinitiva(
  portaId: string,
  chatwootConversationId: number,
) {
  try {
    const cliente = await clienteDoAgente(portaId);
    if (!cliente) return;

    const aoVivo = await cliente.obterConversa(chatwootConversationId);
    if (aoVivo.assigneeId != null) return; // humano já assumiu

    await cliente.enviarMensagem(
      chatwootConversationId,
      "Tive uma instabilidade por aqui e não consegui responder agora. Pode mandar de novo, por favor? Se preferir, um atendente pode continuar seu atendimento.",
    );
  } catch (erro) {
    logger.error(
      { conversa: chatwootConversationId, erro },
      "não consegui avisar o cliente da falha definitiva",
    );
  }
}

async function registrarFalha(
  chatwootConversationId: number,
  motivo: string | null,
) {
  try {
    await db.conversation.updateMany({
      where: { chatwootConversationId },
      data: { ultimaFalha: motivo, ultimaFalhaEm: motivo ? new Date() : null },
    });
  } catch (erro) {
    logger.warn({ chatwootConversationId, erro }, "não consegui registrar a falha");
  }
}

async function atender(job: Job<JobAtendimento>) {
  const { chatwootConversationId, agentId: portaId, inboxId } = job.data;
  const log = logger.child({ conversa: chatwootConversationId, porta: portaId });

  const conversa = await db.conversation.findUnique({
    where: { chatwootConversationId },
  });

  // Reconferência depois do debounce: durante a espera um humano pode ter
  // assumido a conversa.
  if (conversa && conversa.status !== ConversationStatus.BOT) {
    log.info({ status: conversa.status }, "conversa não é mais do bot — ignorando");
    return;
  }

  // O bot é a PORTA, não o agente: o Chatwoot amarra um bot por caixa de
  // entrada, então toda resposta sai por ele, inclusive quando quem pensou foi
  // um especialista. O cliente vê uma identidade só.
  const cliente = await clienteDoAgente(portaId);
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
      await marcarResolvida(chatwootConversationId);
    } else {
      await entregarAoHumano(
        chatwootConversationId,
        veredito.motivo ?? "assumida por uma pessoa",
      );
    }
    return;
  }

  const mensagens = await cliente.listarMensagens(chatwootConversationId);
  const contexto = montarContexto(mensagens, conversa?.historicoDesde);

  if (!contexto) {
    log.info("nada novo do cliente para responder");
    return;
  }

  const equipe = await db.agent.findMany({
    // Arquivado não entra na equipe: não roteia, não recebe transferência e
    // não aparece no prompt de ninguém.
    where: { archivedAt: null },
    select: {
      id: true,
      key: true,
      name: true,
      routingDescription: true,
      active: true,
      isEntry: true,
      inboxMode: true,
      inboxIds: true,
    },
  });

  // A caixa vem do job (o webhook a conhece) e cai para a que o Chatwoot
  // devolveu ao vivo, para o escopo valer mesmo em job antigo na fila.
  let ativo = resolverAgenteAtivo(equipe, {
    donoId: conversa?.agentId,
    portaId,
    inboxId: inboxId ?? aoVivo.inboxId ?? conversa?.chatwootInboxId,
  });

  if (!ativo) {
    log.info("nenhum agente ativo para atender — ignorando");
    return;
  }

  const estado = novoEstado(Date.now());
  registrarVisita(estado, ativo.id);

  // Bastão só vale para quem ele endereça: se o dono mudou por fora, o resumo
  // antigo não deve entrar no prompt de outro agente.
  let bastao =
    conversa?.handoffParaAgentId === ativo.id
      ? mensagemDeBastao({
          deNome: conversa?.handoffDeNome,
          motivo: conversa?.handoffMotivo,
          resumo: conversa?.handoffResumo,
        })
      : null;

  /** Verdade sobre o turno: só vira true depois de um envio confirmado. */
  let clienteRecebeuResposta = false;

  try {
    while (true) {
      await assumirConversa(chatwootConversationId, ativo.id);

      const resultado = await executarAgente({
        agentId: ativo.id,
        source: RunSource.CHATWOOT,
        conversationId: conversa?.id,
        chatwootConversationId,
        // Toda credencial de canal vem da porta: o especialista pode não ter bot.
        canalAgentId: portaId,
        historico: contexto.historico,
        mensagem: contexto.mensagem,
        inboxId: inboxId ?? aoVivo.inboxId ?? conversa?.chatwootInboxId,
        bastao,
      });

      const handoff = resultado.handoff;

      // Entregou a conversa a uma pessoa e já avisou o cliente de dentro da
      // tool (tem de ser antes de atribuir, senão a regra global cala o envio).
      // O turno não terminou mudo — a rede de segurança não deve disparar.
      if (resultado.avisouCliente) clienteRecebeuResposta = true;

      if (!handoff) {
        const resposta = resultado.resposta.trim();

        // A tool de transferência para humano já muda o status; se transferiu e
        // não sobrou texto, não force uma resposta vazia.
        if (!resposta) {
          log.warn({ runId: resultado.runId }, "agente não produziu texto");
          break;
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
          // Humano assumiu: não é silêncio, é a regra funcionando.
          clienteRecebeuResposta = true;
          break;
        }

        await cliente.enviarMensagem(chatwootConversationId, resposta);
        clienteRecebeuResposta = true;

        // Pendente some da visualização padrão do Chatwoot. Conversa que o bot
        // está tocando não pode ficar invisível para a equipe.
        await abrirSePendente(
          cliente,
          chatwootConversationId,
          antesDeEnviar.status,
          log,
        );

        // Respondeu: ninguém mais está esperando, o vigia pode soltar esta.
        await db.conversation.updateMany({
          where: { chatwootConversationId },
          data: { lastMessageAt: new Date(), aguardandoDesde: null },
        });

        log.info(
          {
            agente: ativo.key,
            runId: resultado.runId,
            latenciaMs: resultado.latenciaMs,
            custoUsd: resultado.custoUsd,
            tools: resultado.toolCalls.length,
          },
          "resposta enviada",
        );
        break;
      }

      const destino = equipe.find((a) => a.id === handoff.destinoId && a.active);
      if (!destino) {
        log.warn(
          { destino: handoff.destinoKey },
          "colega de destino sumiu ou foi desligado — seguindo sem transferir",
        );
        break;
      }

      const autorizado = podeTransferir(estado, ativo.id, destino.id, Date.now());
      if (!autorizado.pode) {
        await escalarParaHumano({
          cliente,
          chatwootConversationId,
          de: ativo,
          para: destino,
          motivo: autorizado.motivo,
          log,
        });
        clienteRecebeuResposta = true;
        break;
      }

      // O aviso sai daqui, e não da tool, para que todo envio ao cliente saia de
      // um lugar só: uma transferência que falhasse depois deixaria um "vou te
      // passar" solto na conversa.
      await cliente.enviarMensagem(chatwootConversationId, handoff.aviso.trim());
      clienteRecebeuResposta = true;

      await registrarPassagem({
        conversaId: conversa?.id,
        de: ativo,
        handoff,
        chatwootConversationId,
      });

      registrarTransferencia(estado, ativo.id, destino.id);
      log.info(
        { de: ativo.key, para: destino.key, motivo: handoff.motivo },
        "atendimento transferido",
      );

      bastao = mensagemDeBastao({
        deNome: ativo.name,
        motivo: handoff.motivo,
        resumo: handoff.resumo,
      });
      ativo = destino;
    }
  } finally {
    // INVARIANTE: o turno nunca termina com o cliente sem nada. Vale para
    // exceção no meio do laço, para agente que não produziu texto e para
    // destino que sumiu — todos os caminhos que, sem isto, viram silêncio.
    if (!clienteRecebeuResposta) {
      await garantirRespostaAoCliente({ cliente, chatwootConversationId, log });
    }
  }
}

/**
 * Deixa a conversa aberta quando ela estava pendente.
 *
 * Melhor esforço: falhar aqui não pode desfazer a resposta que o cliente já
 * recebeu — no pior caso a conversa fica pendente e alguém a acha por filtro.
 */
async function abrirSePendente(
  cliente: ChatwootClient,
  chatwootConversationId: number,
  status: string | null,
  log: Registro,
) {
  if (!precisaAbrir(status)) return;

  try {
    await cliente.alternarStatus(chatwootConversationId, "open");
  } catch (erro) {
    log.warn({ erro }, "não consegui tirar a conversa de pendente");
  }
}

/** Quem atende agora. Gravado a cada passo para sobreviver a uma queda no meio. */
async function assumirConversa(chatwootConversationId: number, agentId: string) {
  await db.conversation.updateMany({
    where: { chatwootConversationId },
    data: { agentId },
  });
}

async function registrarPassagem(args: {
  conversaId?: string;
  de: AgenteRoteavel;
  handoff: SinalDeHandoff;
  chatwootConversationId: number;
}) {
  const { conversaId, de, handoff, chatwootConversationId } = args;

  await db.conversation.updateMany({
    where: { chatwootConversationId },
    data: {
      handoffParaAgentId: handoff.destinoId,
      handoffDeNome: de.name,
      handoffMotivo: handoff.motivo ?? null,
      handoffResumo: handoff.resumo ?? null,
    },
  });

  if (!conversaId) return;

  await db.agentHandoff.create({
    data: {
      conversationId: conversaId,
      fromAgentId: de.id,
      toAgentId: handoff.destinoId,
      motivo: handoff.motivo,
      resumo: handoff.resumo,
      aviso: handoff.aviso,
    },
  });
}

/**
 * Trava batida: avisa o cliente, deixa o rastro para a equipe e devolve a
 * conversa à fila humana.
 *
 * Só nota interna não bastaria — a conversa ficaria parada sem ninguém
 * responsável por ela.
 */
async function escalarParaHumano(args: {
  cliente: ChatwootClient;
  chatwootConversationId: number;
  de: AgenteRoteavel;
  para: AgenteRoteavel;
  motivo: MotivoDeParada;
  log: Registro;
}) {
  const { cliente, chatwootConversationId, de, para, motivo, log } = args;

  log.warn(
    { de: de.key, para: para.key, motivo },
    "transferência bloqueada — escalando para humano",
  );

  try {
    await cliente.enviarMensagem(
      chatwootConversationId,
      [
        `⚠️ A equipe de agentes não concluiu este atendimento: ${explicarParada(motivo)}.`,
        `Última tentativa de passagem: "${de.name}" → "${para.name}".`,
        "Alguém precisa continuar daqui.",
      ].join("\n"),
      { privado: true },
    );

    await cliente.alternarStatus(chatwootConversationId, "open");

    await entregarAoHumano(chatwootConversationId, `equipe de agentes: ${motivo}`);

    await cliente.enviarMensagem(
      chatwootConversationId,
      "Peço desculpas pela demora — um atendente da nossa equipe vai continuar seu atendimento em instantes.",
    );
  } catch (erro) {
    log.error({ erro }, "falha ao escalar para humano");
  }
}

/**
 * Rede de segurança final: se nada chegou ao cliente, manda uma mensagem de
 * contorno e uma nota com o motivo técnico.
 *
 * Melhor esforço — a falha dela é engolida para nunca mascarar o problema
 * original, que é o que a nota interna carrega.
 */
async function garantirRespostaAoCliente(args: {
  cliente: ChatwootClient;
  chatwootConversationId: number;
  log: Registro;
}) {
  const { cliente, chatwootConversationId, log } = args;

  try {
    // Se um humano assumiu no meio, o silêncio do bot é o comportamento certo.
    const aoVivo = await cliente.obterConversa(chatwootConversationId);
    if (aoVivo.assigneeId != null) return;

    log.error({}, "turno terminou sem resposta ao cliente — enviando contorno");

    await cliente.enviarMensagem(
      chatwootConversationId,
      "⚠️ O agente não concluiu este atendimento e o cliente ficaria sem resposta. Foi enviada uma mensagem de contorno — confira se alguém precisa assumir.",
      { privado: true },
    );

    await cliente.enviarMensagem(
      chatwootConversationId,
      "Tive uma instabilidade rápida por aqui e não consegui concluir sua resposta agora. Pode mandar de novo, por favor? Se preferir, um atendente pode continuar seu atendimento.",
    );

    // Ainda mais importante aqui: o turno falhou, e é justamente quando alguém
    // precisa enxergar a conversa na fila.
    await abrirSePendente(cliente, chatwootConversationId, aoVivo.status, log);
  } catch (erro) {
    log.error({ erro }, "rede de segurança de resposta também falhou");
  }
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

  // Sinal de vida para o painel poder responder "o worker está rodando?".
  iniciarBatimento();
  // Poda o histórico de entregas — sem isto a tabela cresce para sempre.
  iniciarLimpeza();
  // Pega o que falha em silêncio: modelo pendurado, job perdido, worker morto
  // no meio do turno — nada disso gera erro, só cliente esperando.
  iniciarVigia();

  logger.info("worker de atendimento no ar");
  return worker;
}
