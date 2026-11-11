/**
 * A re-conferência da task que ficou esperando correção.
 *
 * Pedido do Diego em 11/11/2026, depois do primeiro dia real do fluxo de
 * contratação: *"quando há um dado faltando, o agente deve voltar à task a cada
 * 10 minutos para visualizar se a correção foi feita"*. O relato dele: faltou
 * uma informação, ele corrigiu à mão, **e nada mais aconteceu**.
 *
 * Isso não era defeito — era o desenho. O agente validador é acionado por uma
 * automação do ClickUp que dispara na MUDANÇA DE STATUS para `📝 contrato`.
 * Preencher um campo não muda status nenhum, então não havia o que disparar: a
 * task ficava parada, correta, esperando um gatilho que não ia vir.
 *
 * ⚠ **O que esta varredura NÃO faz é rodar o modelo a cada 10 minutos.** Isso
 * seria uma chamada paga por task parada, para sempre, quase toda vez para
 * concluir que nada mudou. Ela olha o `date_updated` que o ClickUp já mantém e
 * só aciona o agente quando a task mudou desde a última conferência. Parada,
 * custa uma listagem; corrigida, custa um turno — que é o que se quer pagar.
 *
 * ⚠ **E a primeira vez que vê uma task, ela NÃO aciona ninguém**: só anota o
 * estado. A automação do ClickUp já disparou quando a task entrou na fila, e
 * sem essa regra o primeiro boot depois do deploy acionaria o agente para toda
 * task parada em `📝 contrato` de uma vez.
 */

import type { ClickUpTarefa } from "@/server/integrations/clickup/tipos";

/** Onde a fila do validador mora, na Base de clientes. */
export const LISTA_BASE_DE_CLIENTES = "900701122530";

/**
 * O status que é a fila.
 *
 * ⚠ O nome real tem EMOJI (`📝 contrato`), e o filtro da API é literal: sem ele
 * a listagem volta vazia, sem erro, para sempre. `ehAFila` compara por "contém
 * contrato" para não quebrar se alguém tirar o emoji da tela — nenhum outro
 * status da lista contém essa palavra ("distrato" não contém "contrato").
 */
export const STATUS_DA_FILA = "📝 contrato";

export function ehAFila(status: string | null | undefined): boolean {
  return (status ?? "").toLowerCase().includes("contrato");
}

/** De dez em dez minutos, que é o intervalo que o Diego pediu. */
export const CONFERIR_A_CADA_MS = 10 * 60_000;

/**
 * Teto de agentes acionados por rodada.
 *
 * A listagem é barata; cada acionamento é um turno pago. Dez por rodada, de dez
 * em dez minutos, escoam qualquer fila real — e seguram o caso em que alguém
 * edita em lote trinta tasks de uma vez.
 */
export const TAREFAS_POR_RODADA = 10;

/**
 * Até onde olhar para trás procurando quem já cuidou daquela task.
 *
 * ⚠ É isto que impede a varredura de acionar agente em task que nenhum agente
 * nunca viu: o `📝 contrato` também recebe task posta à mão pela equipe, e
 * acionar o validador nelas seria trabalho que ninguém pediu.
 */
export const DIAS_PARA_TRAS = 30;

/** A chave da entrega, no formato do gatilho HTTP. */
export function chaveDaReconferencia(taskId: string, mudouEm: string): string {
  return `reconferencia:${taskId}:${mudouEm}`;
}

export type EstadoConhecido = {
  /** O `date_updated` que a rodada anterior viu, em texto. */
  mudouEm: string;
};

/**
 * Aciona o agente de novo?
 *
 * Só quando a task mudou desde a última conferência. Sem estado anterior, a
 * resposta é NÃO: anota-se e espera-se a mudança seguinte.
 */
export function precisaReconferir(
  tarefa: Pick<ClickUpTarefa, "date_updated">,
  conhecido: EstadoConhecido | null,
): boolean {
  const agora = (tarefa.date_updated ?? "").trim();
  if (!agora) return false;
  if (!conhecido) return false;
  return agora !== conhecido.mudouEm;
}

/**
 * O corpo que o agente recebe.
 *
 * ⚠ **Imita o da automação do ClickUp**, com a task em `payload` e o id em
 * `payload.id`: é de lá que o prompt manda tirar o id da task ("Utilize sempre
 * o ID da task como identificador principal"). Mandar outro formato faria o
 * agente não achar a task e encerrar sem fazer nada.
 */
export function payloadDaReconferencia(tarefa: ClickUpTarefa) {
  return {
    reconferencia: true,
    motivo:
      "A task mudou desde a última conferência e continua na fila de contrato. " +
      "Confira os campos de novo e siga as suas instruções: se agora estiver " +
      "tudo certo, mova para Onboarding; se ainda faltar algo, comente só o que " +
      "falta — sem repetir comentário igual ao anterior.",
    date: new Date().toISOString(),
    payload: {
      id: tarefa.id,
      name: tarefa.name,
      status: tarefa.status,
    },
  };
}

/**
 * A fila tem CENTENAS de subtarefas de cadência, e elas não são trabalho.
 *
 * A Base de clientes acumula subtarefas criadas pelo ClickBot desde 2024 —
 * "Whatsapp de follow up", "Ligação de qualificação", "Envio de proposta",
 * "Whatsapp Break Up" — todas paradas em `📝 contrato`. Medido em 11/11/2026: a
 * primeira página da listagem traz 100 tarefas e quase todas são isso.
 *
 * ⚠ Sem esta peneira, a varredura anotaria centenas de linhas na primeira
 * rodada e, pior, acionaria o agente numa task chamada "Whatsapp de follow up",
 * que não tem campo nenhum para conferir. É o mesmo risco que fez a automação
 * do Agente 1 ser trocada de "Tarefas ou subtarefas" para "Tarefas".
 *
 * Duas marcas, porque nenhuma sozinha é garantida: o `parent` preenchido e a
 * etiqueta `subtarefas` que o ClickBot põe.
 */
export const ETIQUETA_DE_CADENCIA = "subtarefas";

export function ehTarefaDeCliente(
  tarefa: Pick<ClickUpTarefa, "parent" | "tags">,
): boolean {
  if (tarefa.parent) return false;
  const etiquetas = (tarefa.tags ?? []).map((t) => t.name.trim().toLowerCase());
  return !etiquetas.includes(ETIQUETA_DE_CADENCIA);
}

/**
 * Teto de tasks ANOTADAS por rodada.
 *
 * A anotação é barata (uma linha), mas descobrir quem cuida de cada task custa
 * consulta. Sem teto, a primeira rodada depois do deploy faria isso para a
 * fila inteira de uma vez.
 */
export const ANOTACOES_POR_RODADA = 20;
