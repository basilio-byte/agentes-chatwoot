import { Prisma } from "@/generated/prisma/client";
import { RunSource } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { dentroDoHorario } from "@/server/cobranca/regras";
import { abrirClickUp } from "@/server/integrations/clickup/sistema";
import type { ClickUpTarefa } from "@/server/integrations/clickup/tipos";
import { agendarGatilho } from "@/server/queue/gatilho";
import {
  ANOTACOES_POR_RODADA,
  chaveDaReconferencia,
  CONFERIR_A_CADA_MS,
  DIAS_PARA_TRAS,
  ehAFila,
  ehTarefaDeCliente,
  LISTA_BASE_DE_CLIENTES,
  payloadDaReconferencia,
  precisaReconferir,
  STATUS_DA_FILA,
  TAREFAS_POR_RODADA,
} from "./regras";

/**
 * A rodada que devolve à fila a task corrigida à mão.
 *
 * O porquê está em `regras.ts`. Aqui ficam as decisões de execução, e a mais
 * importante é esta: **quem é acionado é o agente que já cuidou daquela task**,
 * lido das execuções. Não há chave de agente escrita no código nem campo novo
 * de configuração — o validador se identifica por ter comentado ali antes, o
 * que de quebra impede a varredura de acionar agente em task que a equipe pôs
 * na fila à mão e que nenhum agente nunca viu.
 */

/** Mesma fila e mesmo provider do gatilho HTTP: a entrega aparece em Entregas. */
const PROVIDER = "TRIGGER";

let ultimaConferencia = 0;
let rodando = false;

export type RodadaDeValidacao = {
  acao:
    | "cedo"
    | "em andamento"
    | "fora do horário"
    | "fila vazia"
    | "sem clickup"
    | "conferido";
  motivo?: string;
  naFila?: number;
  acionadas?: number;
  anotadas?: number;
  desfechos?: string[];
};

/**
 * O estado que a rodada anterior anotou para cada task.
 *
 * Mora em `WebhookEvent`, como todo registro de rodada deste projeto: a chave
 * leva o `date_updated`, então a linha de uma task corrigida é outra linha, e a
 * unique do provider impede que a mesma mudança acione o agente duas vezes.
 */
async function estadoConhecido(taskIds: string[]) {
  if (!taskIds.length) return new Map<string, string>();

  const linhas = await db.webhookEvent.findMany({
    where: {
      provider: PROVIDER,
      externalId: { startsWith: "reconferencia:" },
      createdAt: { gte: new Date(Date.now() - DIAS_PARA_TRAS * 24 * 3_600_000) },
    },
    select: { externalId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const porTask = new Map<string, string>();
  for (const linha of linhas) {
    // `reconferencia:<task>:<date_updated>`
    const partes = linha.externalId.split(":");
    if (partes.length < 3) continue;
    const taskId = partes[1];
    if (!taskIds.includes(taskId) || porTask.has(taskId)) continue;
    porTask.set(taskId, partes.slice(2).join(":"));
  }
  return porTask;
}

/**
 * Qual agente já cuidou desta task, por gatilho HTTP.
 *
 * Lido das `ToolCall` daquela task — a mesma fonte que a barreira de task em
 * dobro e o acompanhamento de contratos usam. ⚠ Só vale agente LIGADO e com
 * gatilho ligado: acionar um agente desligado criaria entrega sem desfecho.
 */
async function agenteQueCuidaDaTask(taskId: string): Promise<string | null> {
  const chamadas = await db.toolCall.findMany({
    where: {
      createdAt: { gte: new Date(Date.now() - DIAS_PARA_TRAS * 24 * 3_600_000) },
      toolName: { startsWith: "clickup_" },
      input: { path: ["tarefaId"], equals: taskId },
      run: { source: RunSource.TRIGGER },
    },
    select: { run: { select: { agentId: true, createdAt: true } } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  for (const chamada of chamadas) {
    const agente = await db.agent.findUnique({
      where: { id: chamada.run.agentId },
      select: {
        id: true,
        active: true,
        archivedAt: true,
        trigger: { select: { enabled: true } },
      },
    });
    if (!agente?.active || agente.archivedAt) continue;
    if (!agente.trigger?.enabled) continue;
    return agente.id;
  }
  return null;
}

/** Anota o estado da task sem acionar ninguém. */
async function anotar(taskId: string, mudouEm: string, agentId: string | null) {
  try {
    await db.webhookEvent.create({
      data: {
        provider: PROVIDER,
        externalId: chaveDaReconferencia(taskId, mudouEm),
        eventType: "reconferencia-anotada",
        agentId,
        payload: {},
        processedAt: new Date(),
        resultado: "ignorado",
        detalhe: "primeira vez que vejo esta task na fila — só anotei o estado",
      },
    });
  } catch {
    // Unique: outra rodada anotou primeiro. Nada a fazer.
  }
}

/**
 * Aciona o agente pela fila do gatilho.
 *
 * ⚠ A entrega é criada ANTES do job, como na rota do gatilho: o `jobId` leva o
 * id dela, então a mesma mudança nunca vira dois turnos. Unique batendo quer
 * dizer que esta mudança já foi acionada.
 */
async function acionar(
  agentId: string,
  tarefa: ClickUpTarefa,
  mudouEm: string,
): Promise<string> {
  const payload = payloadDaReconferencia(tarefa);
  let entregaId: string;
  try {
    const criada = await db.webhookEvent.create({
      data: {
        provider: PROVIDER,
        externalId: chaveDaReconferencia(tarefa.id, mudouEm),
        eventType: "reconferencia",
        agentId,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });
    entregaId = criada.id;
  } catch {
    return `${tarefa.id}: esta mudança já tinha sido acionada`;
  }

  await agendarGatilho({
    agentId,
    webhookEventId: entregaId,
    payload,
    eventType: "reconferencia",
  });
  return `${tarefa.id}: acionado`;
}

export async function conferirValidacaoDeContratos(
  opcoes: { forcar?: boolean } = {},
  agora = new Date(),
): Promise<RodadaDeValidacao> {
  if (rodando) return { acao: "em andamento" };
  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" };
  }
  if (!opcoes.forcar && !dentroDoHorario(agora)) return { acao: "fora do horário" };
  rodando = true;
  ultimaConferencia = agora.getTime();

  try {
    const clickup = await abrirClickUp("re-conferência de contratos");
    if ("erro" in clickup) return { acao: "sem clickup", motivo: clickup.erro };

    const { tasks } = await clickup.cliente.listarTarefasDaLista(LISTA_BASE_DE_CLIENTES, {
      statuses: [STATUS_DA_FILA],
    });
    // ⚠ Duas peneiras. `ehAFila` porque o filtro da API é literal e o nome tem
    // emoji; `ehTarefaDeCliente` porque a fila guarda centenas de subtarefas de
    // cadência de 2024, que não têm campo nenhum para conferir.
    const naFila = tasks.filter(
      (t) => ehAFila(t.status?.status) && ehTarefaDeCliente(t),
    );
    if (!naFila.length) return { acao: "fila vazia", naFila: 0 };

    const conhecido = await estadoConhecido(naFila.map((t) => t.id));
    const desfechos: string[] = [];
    let acionadas = 0;
    let anotadas = 0;

    for (const tarefa of naFila) {
      const mudouEm = (tarefa.date_updated ?? "").trim();
      if (!mudouEm) continue;

      const anterior = conhecido.get(tarefa.id);
      if (!precisaReconferir(tarefa, anterior ? { mudouEm: anterior } : null)) {
        if (!anterior && anotadas < ANOTACOES_POR_RODADA) {
          await anotar(tarefa.id, mudouEm, await agenteQueCuidaDaTask(tarefa.id));
          anotadas++;
        }
        continue;
      }

      if (acionadas >= TAREFAS_POR_RODADA) {
        desfechos.push(`${tarefa.id}: ficou para a rodada seguinte (teto)`);
        continue;
      }

      const agentId = await agenteQueCuidaDaTask(tarefa.id);
      if (!agentId) {
        // Task que nenhum agente ligado cuidou: anota para não reavaliar a
        // mesma mudança toda rodada, e não aciona ninguém.
        await anotar(tarefa.id, mudouEm, null);
        anotadas++;
        desfechos.push(`${tarefa.id}: nenhum agente ligado cuidou desta task`);
        continue;
      }

      acionadas++;
      desfechos.push(await acionar(agentId, tarefa, mudouEm));
    }

    return { acao: "conferido", naFila: naFila.length, acionadas, anotadas, desfechos };
  } catch (erro) {
    logger.error({ erro }, "falha na re-conferência de contratos");
    return { acao: "conferido", motivo: (erro as Error).message };
  } finally {
    rodando = false;
  }
}
