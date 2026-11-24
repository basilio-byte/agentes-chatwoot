import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { diaEmSaoPaulo } from "@/lib/tempo";
import { dentroDoHorario } from "@/server/cobranca/regras";
import type { ClickUpClient } from "@/server/integrations/clickup/client";
import { camposDaTarefa } from "@/server/integrations/clickup/campos-da-tarefa";
import { abrirClickUp } from "@/server/integrations/clickup/sistema";
import type { ClickUpTarefa } from "@/server/integrations/clickup/tipos";

import { LISTA_BASE_DE_CLIENTES, PAGINAS_MAXIMAS, tarefaDoFluxo } from "./clickup";
import { configDaRenovacao } from "./config";
import {
  chaveDaNotificacao,
  comentarioDaNotificacao,
  decidirNotificacao,
  type TarefaParaNotificar,
} from "./notificacao";
import { PROVIDER_RENOVACAO, STATUS_NOTIFICACAO, STATUS_RENOVACAO } from "./regras";
import { gravarResumoDoDia } from "./rodadas";

/**
 * A rodada que passa a tarefa de `renovação` para `notificação renovação`
 * depois de dois dias — fase 2b. As regras, e o porquê de cada guarda, estão em
 * `notificacao.ts`.
 *
 * ⚠⚠ **Nasce desligada** (`moverParaNotificacao`): a troca dispara o e-mail de
 * aviso ao CLIENTE, pela automação do ClickUp. Desligada, a rodada é a leitura de
 * uma configuração e para.
 *
 * ⚠ **Reserva antes de escrever**, e a reserva é desfeita se a troca não
 * aconteceu. A chave leva o instante em que a tarefa entrou no status: voltar
 * para `renovação` e ficar mais dois dias é outra entrada e pode ser notificada
 * de novo, mas a MESMA entrada nunca é notificada duas vezes.
 *
 * ⚠ **Teto de 10 por rodada**, pela mesma razão da propagação: é o token que os
 * agentes usam no CRM durante o atendimento, e o cliente do ClickUp não tem
 * balde de fichas.
 */

export const CONFERIR_A_CADA_MS = 30 * 60_000;
export const MOVIDAS_POR_RODADA = 10;
export const PAUSA_ENTRE_TAREFAS_MS = 400;
/** Reserva "reservado" mais velha que isto é de um processo que caiu no meio. */
export const RESERVA_ABANDONADA_MS = 30 * 60_000;
export const CHAVE_DA_RODADA = "notificacao";

let ultimaConferencia = 0;
let rodando = false;

type Cliente = Pick<
  ClickUpClient,
  "listarTarefasDaLista" | "tempoNoStatus" | "obterTarefa" | "atualizarTarefa" | "comentarTarefa"
>;

export type RodadaDeNotificacao = {
  acao:
    | "cedo"
    | "em andamento"
    | "fora do horário"
    | "desligada"
    | "sem clickup"
    | "conferido";
  motivo?: string;
  emRenovacao?: number;
  movidas?: string[];
  esperando?: number;
  /** O que a rodada olhou, quis mover e não moveu — cada item com o motivo. */
  pendentes?: string[];
  erro?: string;
};

function paraNotificar(
  tarefa: ClickUpTarefa,
  entrouEmMs: number | null,
): TarefaParaNotificar {
  const campos = camposDaTarefa(tarefa);
  const texto = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    id: tarefa.id,
    status: tarefa.status?.status ?? "",
    entrouEmMs,
    dataDeReajuste: tarefaDoFluxo(tarefa).dataDeReajuste ?? null,
    categoria: texto(campos["CATEGORIA DE SERVIÇO"]),
    produto: texto(campos["TIPO DE PRODUTO"]),
  };
}

async function tarefasEmRenovacao(cliente: Cliente) {
  const tarefas: ClickUpTarefa[] = [];
  for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina++) {
    const { tasks } = await cliente.listarTarefasDaLista(LISTA_BASE_DE_CLIENTES, {
      statuses: [STATUS_RENOVACAO],
      page: pagina,
    });
    tarefas.push(...tasks);
    if (tasks.length < 100) break;
  }
  return tarefas;
}

export async function moverParaNotificacao(
  opcoes: { forcar?: boolean } = {},
  agora = new Date(),
): Promise<RodadaDeNotificacao> {
  if (rodando) return { acao: "em andamento" };

  const config = await configDaRenovacao();
  if (!config.moverParaNotificacao) return { acao: "desligada" };

  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" };
  }
  if (!opcoes.forcar && !dentroDoHorario(agora)) return { acao: "fora do horário" };
  rodando = true;
  ultimaConferencia = agora.getTime();

  try {
    const hoje = diaEmSaoPaulo(agora);
    const clickup = await abrirClickUp("notificação da renovação");
    if ("erro" in clickup) return { acao: "sem clickup", motivo: clickup.erro };
    const cliente = clickup.cliente as Cliente;

    const lista = await tarefasEmRenovacao(cliente);
    const desde = lista.length
      ? await cliente.tempoNoStatus(lista.map((t) => t.id))
      : {};

    const movidas: string[] = [];
    const pendentes: string[] = [];
    let esperando = 0;

    for (const tarefa of lista) {
      if (movidas.length >= MOVIDAS_POR_RODADA) break;

      const entrada = desde[tarefa.id];
      // ⚠ O tempo lido tem de ser do status DE AGORA: se a leitura de tempo diz
      // outro status, a tarefa mudou entre as duas chamadas e fica para a próxima.
      const entrouEmMs =
        entrada && entrada.status?.trim().toLowerCase() === STATUS_RENOVACAO
          ? entrada.desde
          : null;

      const t = paraNotificar(tarefa, entrouEmMs);
      const decisao = decidirNotificacao(t, hoje);

      if (!decisao.mover) {
        if (decisao.espera) esperando++;
        else pendentes.push(`${tarefa.name}: ${decisao.motivo}`);
        continue;
      }

      const resultado = await moverUma(cliente, tarefa, t.entrouEmMs as number, decisao);
      if (resultado.movida) movidas.push(tarefa.name);
      else if (resultado.motivo) pendentes.push(`${tarefa.name}: ${resultado.motivo}`);

      await new Promise((r) => setTimeout(r, PAUSA_ENTRE_TAREFAS_MS));
    }

    const rodada: RodadaDeNotificacao = {
      acao: "conferido",
      emRenovacao: lista.length,
      movidas,
      esperando,
      pendentes,
    };
    await registrarRodada(agora, rodada);
    return rodada;
  } catch (erro) {
    logger.error({ erro }, "notificação da renovação falhou");
    await registrarRodada(agora, { erro: (erro as Error).message });
    throw erro;
  } finally {
    rodando = false;
  }
}

/** Uma tarefa: reserva, relê ao vivo, troca o status e comenta. */
async function moverUma(
  cliente: Cliente,
  tarefa: ClickUpTarefa,
  entrouEmMs: number,
  decisao: { entrouEm: string; dias: number },
): Promise<{ movida: boolean; motivo?: string }> {
  const chave = chaveDaNotificacao(tarefa.id, entrouEmMs);

  let reservaId: string;
  try {
    reservaId = (
      await db.webhookEvent.create({
        data: {
          provider: PROVIDER_RENOVACAO,
          externalId: chave,
          eventType: "notificacao",
          payload: {},
          resultado: "reservado",
        },
        select: { id: true },
      })
    ).id;
  } catch {
    // Já existe: esta entrada no status já foi tratada — ou um processo caiu no
    // meio e deixou a reserva. Só a reserva abandonada é refeita, e só porque a
    // tarefa AINDA está em `renovação` (se a troca tivesse acontecido, ela não
    // estaria aqui).
    const existente = await db.webhookEvent.findUnique({
      where: { provider_externalId: { provider: PROVIDER_RENOVACAO, externalId: chave } },
      select: { id: true, resultado: true, createdAt: true },
    });
    const abandonada =
      existente?.resultado === "reservado" &&
      Date.now() - existente.createdAt.getTime() > RESERVA_ABANDONADA_MS;
    if (!abandonada || !existente) return { movida: false };
    reservaId = existente.id;
    await db.webhookEvent.update({ where: { id: reservaId }, data: { createdAt: new Date() } });
  }

  const desfazer = () => db.webhookEvent.delete({ where: { id: reservaId } }).catch(() => {});

  try {
    // Confere ao vivo: a pessoa pode ter movido a tarefa à mão agora há pouco.
    const viva = await cliente.obterTarefa(tarefa.id);
    if ((viva.status?.status ?? "").trim().toLowerCase() !== STATUS_RENOVACAO) {
      await desfazer();
      return { movida: false, motivo: `já não estava em "${STATUS_RENOVACAO}" ao conferir` };
    }

    await cliente.atualizarTarefa(tarefa.id, { status: STATUS_NOTIFICACAO });
  } catch (erro) {
    await desfazer();
    return { movida: false, motivo: `o ClickUp recusou a troca — ${(erro as Error).message}` };
  }

  // A troca aconteceu: a reserva fecha, e o comentário é só registro.
  await db.webhookEvent
    .update({
      where: { id: reservaId },
      data: {
        resultado: "movida",
        detalhe: JSON.stringify({ tarefaId: tarefa.id, entrouEm: decisao.entrouEm, dias: decisao.dias }),
        processedAt: new Date(),
      },
    })
    .catch((erro) => logger.error({ erro }, "não consegui fechar a reserva da notificação"));

  try {
    await cliente.comentarTarefa(tarefa.id, comentarioDaNotificacao(decisao.entrouEm, decisao.dias));
  } catch (erro) {
    logger.error({ erro, tarefa: tarefa.id }, "notificação: o comentário não saiu");
  }
  return { movida: true };
}

/**
 * O resumo do dia SOMA as rodadas (ver `resumo-do-dia.ts`): a rodada que não
 * acha nada não apaga a que fez alguma coisa mais cedo.
 */
async function registrarRodada(agora: Date, rodada: RodadaDeNotificacao | { erro: string }) {
  await gravarResumoDoDia({
    chave: CHAVE_DA_RODADA,
    eventType: "notificacao-rodada",
    agora,
    rodada,
    campos: { listas: ["movidas"] },
    resultado: (somado) =>
      "erro" in rodada && rodada.erro
        ? "falhou"
        : Array.isArray(somado.movidas) && somado.movidas.length
          ? "movido"
          : "nada a mover",
  });
}
