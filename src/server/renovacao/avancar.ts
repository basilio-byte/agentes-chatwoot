import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { diaEmSaoPaulo } from "@/lib/tempo";
import { dentroDoHorario } from "@/server/cobranca/regras";
import type { ClickUpClient } from "@/server/integrations/clickup/client";
import { abrirClickUp } from "@/server/integrations/clickup/sistema";

import { LISTA_BASE_DE_CLIENTES, PAGINAS_MAXIMAS } from "./clickup";
import { DIAS_PARA_PROPAGAR, STATUS_DESTINO, STATUS_ORIGEM } from "./propagacao";
import { PROVIDER_RENOVACAO } from "./regras";

/**
 * O status que ficou para trás: a tarefa cujo contrato JÁ levou o reajuste e que
 * só agora chegou a `notificação renovação`.
 *
 * ⚠ **Existe por causa do contrato de fim de mês.** O lote de reajuste cai por
 * volta do dia 20 e a tarefa entra em `renovação` 30 dias antes da data: quem
 * vence do dia 20 em diante entra em `renovação` DEPOIS do lote. A propagação
 * escreve o valor e o percentual na hora, mas — de propósito — não avança o
 * status de `renovação` (pularia o e-mail de aviso) e fecha a reserva. Passados
 * os dois dias, a tarefa vai para `notificação renovação` (pela rodada da 2b ou à
 * mão) e ninguém a levaria a `pg pendente - renovação`: o reajuste está lançado,
 * o cliente avisado, e a tarefa fica parada no status que diz "falta lançar".
 *
 * Aqui a regra é de ESTADO, não de evento: tarefa que uma reserva de propagação
 * nomeou e que está em `notificação renovação` vai para `pg pendente`. Idempotente
 * por natureza — depois da troca ela não casa mais — e mexe só no que a
 * propagação já tocou. Não dispara e-mail nenhum (a transição não acorda
 * automação, conferido na fase 2), então não tem chave.
 */

export const CONFERIR_A_CADA_MS = 30 * 60_000;
export const AVANCADAS_POR_RODADA = 10;
export const PAUSA_ENTRE_TAREFAS_MS = 400;
export const CHAVE_DA_RODADA = "avanco";

let ultimaConferencia = 0;
let rodando = false;

type Cliente = Pick<
  ClickUpClient,
  "listarTarefasDaLista" | "obterTarefa" | "atualizarTarefa" | "comentarTarefa"
>;

const RESULTADOS_QUE_TOCARAM = ["propagado", "propagado em parte", "já estava em dia"];

/**
 * As tarefas que uma reserva de propagação nomeou e cujo status NÃO avançou.
 * Pura: recebe as linhas e devolve os ids.
 */
export function tarefasQueFicaramParaTras(
  eventos: Array<{ resultado: string | null; detalhe: string | null }>,
) {
  const ids = new Set<string>();
  for (const e of eventos) {
    if (!e.resultado || !RESULTADOS_QUE_TOCARAM.includes(e.resultado) || !e.detalhe) continue;
    // Se a propagação avançou o status, o desfecho traz `statusNovo`.
    if (e.detalhe.includes('"statusNovo"')) continue;
    const id = /"tarefaId":"([^"]+)"/.exec(e.detalhe)?.[1];
    if (id) ids.add(id);
  }
  return ids;
}

export type RodadaDeAvanco = {
  acao: "cedo" | "em andamento" | "fora do horário" | "sem clickup" | "nada a avancar" | "conferido";
  motivo?: string;
  candidatas?: number;
  avancadas?: string[];
  pendentes?: string[];
};

export async function avancarTarefasDoLote(
  opcoes: { forcar?: boolean } = {},
  agora = new Date(),
): Promise<RodadaDeAvanco> {
  if (rodando) return { acao: "em andamento" };
  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" };
  }
  if (!opcoes.forcar && !dentroDoHorario(agora)) return { acao: "fora do horário" };
  rodando = true;
  ultimaConferencia = agora.getTime();

  try {
    const desde = new Date(agora.getTime() - DIAS_PARA_PROPAGAR * 86_400_000);
    const eventos = await db.webhookEvent.findMany({
      where: {
        provider: PROVIDER_RENOVACAO,
        externalId: { startsWith: "reajuste:" },
        createdAt: { gte: desde },
      },
      select: { resultado: true, detalhe: true },
    });
    const nomeadas = tarefasQueFicaramParaTras(eventos);
    // Só o banco até aqui: sem tarefa nomeada, nem se abre o ClickUp.
    if (!nomeadas.size) return { acao: "nada a avancar" };

    const clickup = await abrirClickUp("avanço de status da renovação");
    if ("erro" in clickup) return { acao: "sem clickup", motivo: clickup.erro };
    const cliente = clickup.cliente as Cliente;

    // Uma listagem do status de origem em vez de uma leitura por tarefa nomeada.
    const emNotificacao = [];
    for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina++) {
      const { tasks } = await cliente.listarTarefasDaLista(LISTA_BASE_DE_CLIENTES, {
        statuses: [STATUS_ORIGEM],
        page: pagina,
      });
      emNotificacao.push(...tasks);
      if (tasks.length < 100) break;
    }
    const alvos = emNotificacao.filter((t) => nomeadas.has(t.id));

    const avancadas: string[] = [];
    const pendentes: string[] = [];
    for (const tarefa of alvos.slice(0, AVANCADAS_POR_RODADA)) {
      try {
        // Confere ao vivo: alguém pode ter movido a tarefa há instantes.
        const viva = await cliente.obterTarefa(tarefa.id);
        if ((viva.status?.status ?? "").trim().toLowerCase() !== STATUS_ORIGEM) continue;

        await cliente.atualizarTarefa(tarefa.id, { status: STATUS_DESTINO });
        avancadas.push(tarefa.name);
        await cliente
          .comentarTarefa(
            tarefa.id,
            `➡️ **Movida pelo sistema para "${STATUS_DESTINO}"** — o reajuste deste contrato já estava lançado e a tarefa acabou de chegar a "${STATUS_ORIGEM}" (a propagação não avança o status enquanto a tarefa está em "renovação", para não pular o e-mail de aviso).`,
          )
          .catch((erro) => logger.error({ erro, tarefa: tarefa.id }, "avanço: o comentário não saiu"));
      } catch (erro) {
        pendentes.push(`${tarefa.name}: ${(erro as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, PAUSA_ENTRE_TAREFAS_MS));
    }

    const rodada: RodadaDeAvanco = {
      acao: "conferido",
      candidatas: alvos.length,
      avancadas,
      pendentes,
    };
    if (avancadas.length || pendentes.length) {
      await registrarRodada(agora, avancadas.length ? "avançado" : "nada avançado", rodada);
    }
    return rodada;
  } finally {
    rodando = false;
  }
}

async function registrarRodada(agora: Date, resultado: string, detalhe: unknown) {
  try {
    const externalId = `${CHAVE_DA_RODADA}:${diaEmSaoPaulo(agora)}`;
    const dados = {
      resultado,
      detalhe: JSON.stringify(detalhe).slice(0, 2000),
      processedAt: agora,
    };
    await db.webhookEvent.upsert({
      where: { provider_externalId: { provider: PROVIDER_RENOVACAO, externalId } },
      create: {
        provider: PROVIDER_RENOVACAO,
        externalId,
        eventType: "avanco-rodada",
        payload: {},
        ...dados,
      },
      update: dados,
    });
  } catch (erro) {
    logger.error({ erro }, "não consegui registrar o desfecho do avanço");
  }
}
