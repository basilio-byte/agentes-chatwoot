import type { Job } from "bullmq";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { executarAgente } from "@/server/agents/runner";
import { ehInterrupcao } from "@/server/agents/cancelamento";
import { RunSource } from "@/generated/prisma/enums";
import {
  atrasoEmMinutos,
  decidirPeloAtraso,
  ocorrenciaAnterior,
} from "@/server/agenda/cron";
import { montarMensagemDoAgendamento } from "@/server/agenda/mensagem";
import { getRedis } from "./conexao";
import { removerAgendador, type JobAgendamento } from "./agendamento";

const PROVIDER = "SCHEDULE";

/**
 * Falhas seguidas antes de o agendamento se desligar sozinho.
 *
 * Mesma doutrina do teto do gatilho HTTP: agendamento quebrado — instrução que
 * o modelo não consegue cumprir, integração fora do ar, credencial expirada —
 * roda todo dia queimando crédito sem produzir nada, e ninguém olha. Três é
 * tolerante o bastante para instabilidade e curto o bastante para não virar
 * fatura.
 */
export const FALHAS_ATE_DESLIGAR = 3;

/**
 * Enquanto um turno deste agendamento estiver rodando, o próximo não entra.
 *
 * TTL generoso porque o que ele protege é a sobreposição, não a corrida: um
 * turno com muitas tools passa de dez minutos, e um agendamento de cinco em
 * cinco minutos empilharia execuções até derrubar o worker. Se o processo
 * morrer no meio, a trava expira sozinha em vez de travar o agendamento para
 * sempre.
 */
const TRAVA_TTL_S = 30 * 60;
const CHAVE_TRAVA = (scheduleId: string) => `agendamento:rodando:${scheduleId}`;

type Desfecho = "executado" | "falhou" | "pulado" | "interrompido";

/**
 * Executa um agendamento — o agente disparado pelo relógio.
 *
 * Sem conversa, sem cliente e sem canal de resposta: ele age só pelas tools que
 * tiver ligadas, exatamente como o gatilho HTTP. O que o modelo escrever como
 * resposta não vai para lugar nenhum, e a instrução do operador diz isso.
 */
export async function processarAgendamento(job: Job<JobAgendamento>) {
  const { scheduleId } = job.data;
  const log = logger.child({ scheduleId });

  const schedule = await db.agentSchedule.findUnique({
    where: { id: scheduleId },
    include: {
      agent: { select: { active: true, archivedAt: true } },
    },
  });

  if (!schedule) {
    log.warn(
      {},
      "agendamento sumiu — o agendador sai na próxima reconciliação",
    );
    return;
  }

  const ocorrencia = ocorrenciaAnterior(schedule.cron) ?? new Date();
  // A ocorrência entra na chave: é o que torna o disparo idempotente. Se o
  // BullMQ entregar a mesma duas vezes, a unique barra a segunda ANTES de
  // rodar o modelo — sem isso, uma reentrega custaria uma execução paga.
  const entrega = `${scheduleId}:${ocorrencia.toISOString()}`;

  let eventoId: string;
  try {
    const criado = await db.webhookEvent.create({
      data: {
        provider: PROVIDER,
        externalId: entrega,
        eventType: schedule.nome,
        agentId: schedule.agentId,
        payload: { scheduleId, cron: schedule.cron } as Prisma.InputJsonValue,
      },
    });
    eventoId = criado.id;
  } catch (erro) {
    if (ehConflitoDeUnique(erro)) {
      log.info({ entrega }, "ocorrência já processada — entrega repetida ignorada");
      return;
    }
    throw erro;
  }

  // Reconferência: agendamento ou agente podem ter sido desligados desde o
  // último boot do agendador.
  if (!schedule.enabled || !schedule.agent.active || schedule.agent.archivedAt) {
    await encerrar(schedule.id, eventoId, "pulado", "agendamento ou agente desligado");
    return;
  }

  const veredito = decidirPeloAtraso(
    atrasoEmMinutos(schedule.cron),
    schedule.toleranciaMinutos,
  );
  if (!veredito.executa) {
    const detalhe =
      `ocorrência chegou ${veredito.atrasoMinutos} min atrasada, acima da tolerância ` +
      `de ${veredito.toleranciaMinutos} min — provável janela de worker fora do ar`;
    log.warn({ atraso: veredito.atrasoMinutos }, "ocorrência atrasada demais — pulada");
    await encerrar(schedule.id, eventoId, "pulado", detalhe);
    return;
  }

  if (!(await pegarTrava(schedule.id))) {
    await encerrar(
      schedule.id,
      eventoId,
      "pulado",
      "a execução anterior deste agendamento ainda está rodando",
    );
    return;
  }

  try {
    const resultado = await executarAgente({
      agentId: schedule.agentId,
      source: RunSource.SCHEDULE,
      mensagem: montarMensagemDoAgendamento({
        nome: schedule.nome,
        instrucao: schedule.instrucao,
      }),
    });

    await encerrar(
      schedule.id,
      eventoId,
      "executado",
      `run ${resultado.runId} · ${resultado.toolCalls.length} tool(s) · ${resultado.iteracoes} iteração(ões)`,
    );
  } catch (erro) {
    // Parada pedida no painel encerra aqui: relançar faria o BullMQ rodar o
    // turno inteiro de novo, tools e tudo.
    if (ehInterrupcao(erro)) {
      await encerrar(schedule.id, eventoId, "interrompido", erro.message);
      return;
    }

    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await encerrar(schedule.id, eventoId, "falhou", mensagem);

    const runId = (erro as { runId?: string } | undefined)?.runId;
    const jaExecutouTool = runId
      ? (await db.toolCall.count({ where: { runId } })) > 0
      : false;

    if (jaExecutouTool) {
      // Mesma regra do gatilho HTTP: o BullMQ reexecuta o job inteiro, e uma
      // tool que já rodou mudou algo de verdade num sistema externo.
      log.error({}, "agendamento falhou depois de executar tool — sem nova tentativa");
      return;
    }

    log.error(
      { erro: mensagem },
      "agendamento falhou antes de qualquer tool — tentando de novo",
    );
    throw erro;
  } finally {
    await soltarTrava(schedule.id);
  }
}

/**
 * `SET NX` como trava: só o primeiro turno grava, os concorrentes desistem.
 *
 * Falha de Redis devolve `true` — o pior caso vira sobreposição, e recusar a
 * execução por instabilidade no Redis transformaria um soluço em agendamento
 * que não roda.
 */
async function pegarTrava(scheduleId: string): Promise<boolean> {
  try {
    const gravou = await getRedis().set(
      CHAVE_TRAVA(scheduleId),
      "1",
      "EX",
      TRAVA_TTL_S,
      "NX",
    );
    return gravou === "OK";
  } catch {
    return true;
  }
}

async function soltarTrava(scheduleId: string) {
  try {
    await getRedis().del(CHAVE_TRAVA(scheduleId));
  } catch {
    // O TTL resolve.
  }
}

/**
 * Grava o desfecho nos dois lugares: na linha do agendamento (o que a tela
 * mostra) e na entrega (o histórico de disparos).
 *
 * `pulado` e `interrompido` **não** contam como falha. Nenhum dos dois indica
 * agendamento quebrado — pular por atraso é o sistema funcionando, e parar é
 * decisão de alguém —, e contá-los desligaria por engano um agendamento são.
 */
async function encerrar(
  scheduleId: string,
  eventoId: string,
  resultado: Desfecho,
  detalhe: string,
) {
  const contaFalha = resultado === "falhou";

  try {
    const atualizado = await db.agentSchedule.update({
      where: { id: scheduleId },
      data: {
        ultimaExecucaoEm: new Date(),
        ultimoResultado: resultado,
        ultimoDetalhe: detalhe.slice(0, 500),
        // Só o sucesso zera. `pulado` mantém o placar como estava: uma janela
        // de worker fora do ar não absolve um agendamento que vinha falhando.
        falhasConsecutivas: contaFalha
          ? { increment: 1 }
          : resultado === "executado"
            ? 0
            : undefined,
      },
      select: { falhasConsecutivas: true },
    });

    if (contaFalha && atualizado.falhasConsecutivas >= FALHAS_ATE_DESLIGAR) {
      const motivo = `desligado automaticamente após ${atualizado.falhasConsecutivas} falhas seguidas`;
      await db.agentSchedule.update({
        where: { id: scheduleId },
        data: {
          enabled: false,
          pausadoAutomaticamenteEm: new Date(),
          pausadoAutomaticamenteMotivo: motivo,
        },
      });
      // Tira do Redis também: só desligar no banco deixaria o agendador
      // disparando até o próximo boot do worker.
      await removerAgendador(scheduleId).catch(() => {});

      logger.error({ scheduleId, motivo }, "agendamento desligado sozinho");
    }
  } catch (erro) {
    logger.warn({ scheduleId, erro }, "não consegui gravar o desfecho do agendamento");
  }

  try {
    await db.webhookEvent.update({
      where: { id: eventoId },
      data: { processedAt: new Date(), resultado, detalhe: detalhe.slice(0, 500) },
    });
  } catch (erro) {
    logger.warn({ eventoId, erro }, "não consegui marcar a entrega do agendamento");
  }
}

function ehConflitoDeUnique(erro: unknown) {
  return (
    typeof erro === "object" &&
    erro !== null &&
    "code" in erro &&
    (erro as { code?: string }).code === "P2002"
  );
}
