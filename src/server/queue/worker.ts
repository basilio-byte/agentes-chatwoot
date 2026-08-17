import { Worker, type Job } from "bullmq";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getRedis } from "./conexao";
import {
  agendarAtendimento,
  consumirPendente,
  FILA_ATENDIMENTO,
  type JobAtendimento,
} from "./atendimento";
import { iniciarBatimento } from "./batimento";
import { iniciarLimpeza } from "./limpeza";
import { iniciarVigia } from "./vigia";
import { FILA_GATILHO, type JobGatilho } from "./gatilho";
import { processarGatilho } from "./gatilho-worker";
import { executarAgente } from "@/server/agents/runner";
import {
  clienteDoAgente,
  obterConfigChatwoot,
  obterSegredosDoBot,
} from "@/server/integrations/chatwoot/credenciais";
import type {
  ChatwootClient,
  MensagemChatwoot,
} from "@/server/integrations/chatwoot/client";
import {
  mensagensCandidatas,
  montarContexto,
} from "@/server/integrations/chatwoot/historico";
import { contextoDeMidia } from "@/server/integrations/openai/credenciais";
import {
  enriquecerComMidia,
  marcarAnexosSemLeitura,
} from "@/server/integrations/openai/enriquecer";
import {
  donoNaoEhHumano,
  ehResolvida,
  podeAgir,
  precisaAbrir,
} from "@/server/integrations/chatwoot/regras";
import { donoEhHumano } from "@/server/integrations/chatwoot/humanos";
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

/** O que o turno já fez, para quem está fora dele poder decidir. */
type EstadoDoTurno = { clienteRecebeuResposta: boolean };

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
  const turno: EstadoDoTurno = { clienteRecebeuResposta: false };

  try {
    await atender(job, turno);
    // Deu certo: limpa a falha anterior para o painel não mostrar erro velho.
    await registrarFalha(chatwootConversationId, null);
  } catch (erro) {
    // Falha ANTES da chamada ao modelo não cria AgentRun — sem este registro, a
    // causa existiria só no log do container e o painel diria "ainda sem
    // resposta" para sempre.
    const motivo = erro instanceof Error ? erro.message : String(erro);
    await registrarFalha(chatwootConversationId, motivo);

    // O BullMQ reexecuta o turno INTEIRO, e o turno não é idempotente: o
    // modelo roda de novo, o cliente recebe a mesma resposta (ou o mesmo "vou
    // te passar") de novo, e a OpenRouter cobra de novo. Uma falha depois de já
    // termos falado com o cliente — gravar a passagem, mexer no status, o
    // segundo agente de uma cadeia — não pode virar nova tentativa.
    //
    // Não é silêncio: o cliente já tem resposta, a falha ficou em
    // `ultimaFalha` e o vigia continua de olho se ninguém aparecer.
    if (turno.clienteRecebeuResposta) {
      logger.error(
        { conversa: chatwootConversationId, erro: motivo },
        "turno falhou DEPOIS de falar com o cliente — sem nova tentativa, para não duplicar",
      );
      return;
    }

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

    const aoVivo = await comDonoIdentificado(
      cliente,
      await cliente.obterConversa(chatwootConversationId),
    );
    // Só uma PESSOA cala este aviso. O próprio bot como responsável não conta —
    // era assim que o cliente ficava sem nem o pedido de desculpas.
    if (aoVivo.assigneeId != null && !donoNaoEhHumano(aoVivo)) return;

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

async function atender(job: Job<JobAtendimento>, turno: EstadoDoTurno) {
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
  const aoVivo = await reabrirSeResolvida(
    cliente,
    chatwootConversationId,
    // O dono precisa ser identificado ANTES de qualquer decisão: o Chatwoot
    // atribui o próprio bot em algumas caixas, e sem esta conferência ele lia a
    // si mesmo como "humano assumiu" e calava a conversa para sempre.
    await comDonoIdentificado(
      cliente,
      await cliente.obterConversa(chatwootConversationId),
    ),
    log,
  );
  const veredito = podeAgir(aoVivo);

  // Achou a si mesmo como responsável: solta a conversa. Sem isso ela some do
  // painel — o bot não aparece no filtro de "Agente atribuído", então não há
  // como listá-la nem descobrir que existe.
  if (veredito.donoNaoHumano) {
    await soltarConversa(cliente, chatwootConversationId, log);
  }

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

  // Áudio, imagem e documento viram texto ANTES de o contexto ser montado: uma
  // mensagem que só tem anexo chega aqui com `content` vazio e seria descartada
  // por `montarContexto`. Passo de preparo, não tool — o agente não escolhe se
  // vai ouvir o cliente.
  const comMidia = await lerMidiaDaConversa({
    mensagens,
    portaId,
    conversaId: conversa?.id,
    historicoDesde: conversa?.historicoDesde,
    log,
  });

  const contexto = montarContexto(comMidia, conversa?.historicoDesde);

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
      if (resultado.avisouCliente) turno.clienteRecebeuResposta = true;

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
        const antesDeEnviar = await comDonoIdentificado(
          cliente,
          await cliente.obterConversa(chatwootConversationId),
        );
        const aindaPode = podeAgir(antesDeEnviar);
        if (!aindaPode.pode) {
          log.info(
            { motivo: aindaPode.motivo, runId: resultado.runId },
            "estado mudou durante a geração — resposta descartada",
          );
          if (aindaPode.resolvida) await marcarResolvida(chatwootConversationId);
          // Humano assumiu: não é silêncio, é a regra funcionando.
          turno.clienteRecebeuResposta = true;
          break;
        }

        await cliente.enviarMensagem(chatwootConversationId, resposta);
        turno.clienteRecebeuResposta = true;

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
        turno.clienteRecebeuResposta = true;
        break;
      }

      // O aviso sai daqui, e não da tool, para que todo envio ao cliente saia de
      // um lugar só: uma transferência que falhasse depois deixaria um "vou te
      // passar" solto na conversa.
      await cliente.enviarMensagem(chatwootConversationId, handoff.aviso.trim());
      turno.clienteRecebeuResposta = true;

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
    if (!turno.clienteRecebeuResposta) {
      await garantirRespostaAoCliente({ cliente, chatwootConversationId, log });
    }
  }
}

/**
 * Troca os anexos da conversa pelo texto que o modelo consegue ler.
 *
 * Melhor esforço, e por isso engole a própria falha: a leitura de mídia é um
 * enfeite comparada a responder o cliente. Se a OpenAI estiver fora do ar, o
 * turno continua — com a marcação de "anexo não lido" na mensagem, que é
 * infinitamente melhor do que a mensagem chegar vazia e o agente responder
 * "não entendi" sem saber que existia um áudio.
 *
 * A capacidade é resolvida pela **porta** (o agente dono do bot), e não por quem
 * vai pensar: é a mesma decisão que o webhook tomou para agendar este job, e
 * porta e pensador discordarem viraria mensagem agendada e nunca respondida.
 */
async function lerMidiaDaConversa(args: {
  mensagens: MensagemChatwoot[];
  portaId: string;
  conversaId?: string;
  historicoDesde?: Date | null;
  log: Registro;
}): Promise<MensagemChatwoot[]> {
  const { mensagens, portaId, conversaId, historicoDesde, log } = args;

  // Só as que chegariam ao modelo: ler anexo de mensagem que o corte de
  // histórico vai descartar é dinheiro jogado fora. E só anexo de ENTRADA — o
  // que a equipe enviou não é lido (ver `enriquecerComMidia`), então nem vale
  // resolver credencial por causa dele.
  const candidatas = mensagensCandidatas(mensagens, historicoDesde);
  const temAnexoDoCliente = candidatas.some(
    (m) => m.message_type === 0 && (m.attachments?.length ?? 0) > 0,
  );
  if (!temAnexoDoCliente) return mensagens;

  try {
    const { config: configChatwoot } = await obterConfigChatwoot();
    const segredos = await obterSegredosDoBot(portaId);

    const ctx = await contextoDeMidia({
      agentId: portaId,
      conversationId: conversaId,
      chatwootBaseUrl: configChatwoot?.baseUrl,
      chatwootToken: segredos?.token,
    });

    if (!ctx) {
      // Desligada: a mensagem não pode continuar vazia, ou o agente responde
      // como se nada tivesse chegado.
      log.info({}, "conversa tem anexo e a leitura de mídia está desligada");
      return marcarAnexosSemLeitura(mensagens);
    }

    const { mensagens: enriquecidas, resumo } = await enriquecerComMidia(
      candidatas,
      ctx,
    );

    log.info(
      {
        lidos: resumo.lidos,
        processados: resumo.processados,
        falhas: resumo.falhas,
        adiados: resumo.adiados,
      },
      "anexos lidos",
    );

    return enriquecidas;
  } catch (erro) {
    log.error({ erro }, "leitura de mídia falhou — seguindo com o anexo marcado");
    return marcarAnexosSemLeitura(mensagens);
  }
}

/** Estado ao vivo da conversa, já com a identidade do dono resolvida. */
type EstadoAoVivo = {
  status: string | null;
  assigneeId: number | null;
  inboxId: number | null;
  labels: string[];
  donoEhHumano?: boolean;
};

/**
 * Descobre se o responsável é uma pessoa, antes de qualquer decisão.
 *
 * Sem dono, nada a fazer — e é o caso da esmagadora maioria das conversas que o
 * bot atende, então isto quase nunca custa uma requisição.
 */
async function comDonoIdentificado(
  cliente: ChatwootClient,
  aoVivo: Omit<EstadoAoVivo, "donoEhHumano">,
): Promise<EstadoAoVivo> {
  if (aoVivo.assigneeId == null) return aoVivo;
  return { ...aoVivo, donoEhHumano: await donoEhHumano(cliente, aoVivo.assigneeId) };
}

/**
 * Tira o próprio bot de responsável pela conversa.
 *
 * Melhor esforço: falhar aqui não pode impedir o atendimento. O que resolve o
 * silêncio é a regra ter parado de tratar o bot como humano; desatribuir é o
 * que devolve a conversa para "Não atribuídas" e a torna visível de novo.
 */
async function soltarConversa(
  cliente: ChatwootClient,
  chatwootConversationId: number,
  log: Registro,
) {
  try {
    await cliente.desatribuir(chatwootConversationId);
    log.info({}, "conversa estava atribuída ao próprio bot — responsável liberado");
  } catch (erro) {
    log.warn({ erro }, "não consegui tirar o bot de responsável pela conversa");
  }
}

/**
 * Reabre no Chatwoot a conversa resolvida em que o cliente acabou de escrever.
 *
 * Existe um job para esta conversa, e job só nasce de mensagem de cliente —
 * então ela voltou a existir, por definição. O Chatwoot normalmente reabre
 * sozinho ao receber mensagem em conversa encerrada, mas em 2026-08-03 a
 * conversa ficou `resolved` mesmo com a mensagem entregue, e o atendimento
 * morreu ali: sem reabrir, `podeAgir` recusa, nada mais muda aquele status, e a
 * conversa fica muda para sempre.
 *
 * **Só reabre o que não tem dono.** Conversa resolvida com um humano atribuído
 * continua sendo dele — reabrir seria o bot tomando de volta um atendimento que
 * uma pessoa encerrou.
 *
 * Melhor esforço: se a reabertura falhar, seguimos com o estado real e as
 * regras globais decidem — o pior caso volta a ser o de hoje, não pior que ele.
 */
async function reabrirSeResolvida(
  cliente: ChatwootClient,
  chatwootConversationId: number,
  aoVivo: EstadoAoVivo,
  log: Registro,
) {
  // Dono que não é gente não segura a reabertura: era exatamente esse o nó —
  // conversa resolvida e atribuída ao próprio bot nunca reabria, porque reabrir
  // exigia não ter dono, e nada mais mudaria aquele status.
  const temDonoDeVerdade = aoVivo.assigneeId != null && !donoNaoEhHumano(aoVivo);
  if (!ehResolvida(aoVivo.status) || temDonoDeVerdade) return aoVivo;

  try {
    await cliente.alternarStatus(chatwootConversationId, "open");
    log.info({}, "conversa resolvida reaberta pela mensagem do cliente");
    return { ...aoVivo, status: "open" };
  } catch (erro) {
    log.warn({ erro }, "não consegui reabrir a conversa resolvida");
    return aoVivo;
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
    // O próprio bot como responsável não é um humano assumindo.
    const aoVivo = await comDonoIdentificado(
      cliente,
      await cliente.obterConversa(chatwootConversationId),
    );
    if (aoVivo.assigneeId != null && !donoNaoEhHumano(aoVivo)) return;

    // Idem se resolveram a conversa enquanto o agente pensava. A regra de ouro
    // — conversa resolvida não recebe interação — vale também para a rede de
    // segurança: um contorno aqui reabriria a discussão numa conversa que uma
    // pessoa acabou de encerrar. E não é silêncio de falha: é a regra.
    if (ehResolvida(aoVivo.status)) {
      log.info({}, "conversa foi resolvida durante o turno — sem contorno");
      return;
    }

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

/**
 * Segundos até processar a mensagem que chegou durante o turno.
 *
 * Curto de propósito: ela já esperou um turno inteiro: um novo debounce cheio
 * só faria o cliente esperar duas vezes. Se ele ainda estiver digitando, o
 * próprio webhook reagenda com o debounce do agente.
 */
const DEBOUNCE_DO_REAGENDAMENTO_S = 1;

/**
 * Processa a mensagem que chegou enquanto o turno rodava.
 *
 * Melhor esforço e fora do handler: falhar aqui não pode derrubar um turno que
 * já deu certo. Se falhar, a mensagem espera a próxima do cliente — e o agente
 * relê o histórico inteiro, então nada de conteúdo se perde.
 */
async function reprocessarPendente(dados: JobAtendimento) {
  try {
    if (!(await consumirPendente(dados.chatwootConversationId))) return;

    logger.info(
      { conversa: dados.chatwootConversationId },
      "mensagem chegou durante o turno — reagendando",
    );
    await agendarAtendimento(dados, DEBOUNCE_DO_REAGENDAMENTO_S);
  } catch (erro) {
    logger.error(
      { conversa: dados.chatwootConversationId, erro },
      "não consegui reagendar a mensagem que chegou durante o turno",
    );
  }
}

/**
 * Os dois workers do processo. `close()` de cada um é exposto porque o
 * shutdown (`src/worker.ts`) precisa esperar os dois — matar um sem esperar
 * o outro corta jobs em andamento sem necessidade.
 */
export type Workers = {
  atendimento: Worker<JobAtendimento>;
  gatilho: Worker<JobGatilho>;
};

export function iniciarWorker(): Workers {
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
    // Só aqui dá para reagendar: dentro do handler o job ainda está `active`,
    // e o `add` com o mesmo jobId seria ignorado — que é justamente o bug que
    // este caminho conserta.
    void reprocessarPendente(job.data);
  });

  // Fila separada, mesmo processo — igual a iniciarVigia/iniciarBatimento
  // logo abaixo: mais uma coisa rodando ao lado, zero serviço novo de deploy.
  const workerGatilho = new Worker<JobGatilho>(FILA_GATILHO, processarGatilho, {
    connection: getRedis(),
    concurrency: 4,
  });

  workerGatilho.on("failed", (job, erro) => {
    logger.error(
      { jobId: job?.id, tentativa: job?.attemptsMade, erro: erro.message },
      "gatilho falhou",
    );
  });

  // Sinal de vida para o painel poder responder "o worker está rodando?".
  iniciarBatimento();
  // Poda o histórico de entregas — sem isto a tabela cresce para sempre.
  iniciarLimpeza();
  // Pega o que falha em silêncio: modelo pendurado, job perdido, worker morto
  // no meio do turno — nada disso gera erro, só cliente esperando.
  iniciarVigia();

  logger.info("worker de atendimento no ar");
  return { atendimento: worker, gatilho: workerGatilho };
}
