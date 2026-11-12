import { logger } from "@/lib/logger";
import type { ClickUpClient } from "./client";

/**
 * Venda de endereço fechada pelo agente que nasce SEM os dados que o contrato
 * exige (`contato/contrato.ts`): a task vai para o Backlog e o motivo fica escrito
 * num comentário (chamado do Formulário Bugs, 10/11/2026, venda da conversa 14286).
 *
 * Antes, a task ficava parada no status em que nasceu: o Endereço Sócio ficou em
 * branco, a regra do ClickBot que leva a venda à Base de clientes não disparou, e
 * ninguém foi avisado do porquê — o Diego precisou mapear campo por campo e
 * duplicar a task à mão. O ClickBot já devolve ao Backlog quem está sem Ramo,
 * VENCIMENTO ou Razão Social; aqui é o sistema quem faz isso pelo resto da lista
 * dos campos exigidos, e o comentário diz a causa.
 *
 * ⚠ Nunca lança: a task já foi criada, e a venda não pode ser perdida por causa do
 * aviso. O que falhar volta em `problemas`.
 */

export const STATUS_DO_BACKLOG = "backlog";

/**
 * As regras do ClickBot rodam ~2 s depois da criação (medido na Atividade da
 * task da conversa 14818, em 26/10/2026). Mover antes disso deixaria a regra
 * "venda autônoma → Aguardando pagamento" ter a última palavra, e a task
 * voltaria a parar no status errado sem a Base de clientes. Objeto, e não
 * constante, para o teste zerar a espera.
 */
export const ajustes = { esperaDasRegrasMs: 4_000 };

export type ResultadoDaDevolucao = {
  /** A task está no Backlog (foi movida agora ou já estava lá). */
  noBacklog: boolean;
  comentou: boolean;
  problemas: string[];
};

export function comentarioDaVendaIncompleta(faltam: string[], noBacklog: boolean): string {
  const linhas = [
    "⚠ Venda de endereço fechada pelo agente, mas os dados do contrato estão incompletos, então ela NÃO sobe sozinha para a Base de clientes.",
    `Falta preencher: ${faltam.join(", ")}.`,
    noBacklog
      ? 'A task foi para o Backlog por isso. Depois de preencher, mova para "Aguardando pagamento" para a automação seguir.'
      : 'Não consegui movê-la para o Backlog: mova à mão. Depois de preencher o que falta, ela precisa estar em "Aguardando pagamento" para a automação seguir.',
  ];
  return linhas.join("\n");
}

type ClienteDaDevolucao = Pick<ClickUpClient, "obterTarefa" | "atualizarTarefa" | "comentarTarefa">;

export async function devolverAoBacklog(args: {
  cliente: ClienteDaDevolucao;
  tarefaId: string;
  faltam: string[];
  esperar?: (ms: number) => Promise<void>;
}): Promise<ResultadoDaDevolucao> {
  const esperar = args.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const problemas: string[] = [];
  let noBacklog = false;
  let comentou = false;

  if (ajustes.esperaDasRegrasMs > 0) await esperar(ajustes.esperaDasRegrasMs);

  try {
    const atual = await args.cliente.obterTarefa(args.tarefaId);
    if (atual.status?.status?.trim().toLowerCase() === STATUS_DO_BACKLOG) {
      noBacklog = true;
    } else {
      await args.cliente.atualizarTarefa(args.tarefaId, { status: STATUS_DO_BACKLOG });
      noBacklog = true;
    }
  } catch (erro) {
    logger.warn({ erro, tarefaId: args.tarefaId }, "venda incompleta: não consegui mover a task para o Backlog");
    problemas.push("não consegui mover a task para o Backlog");
  }

  try {
    await args.cliente.comentarTarefa(args.tarefaId, comentarioDaVendaIncompleta(args.faltam, noBacklog));
    comentou = true;
  } catch (erro) {
    logger.warn({ erro, tarefaId: args.tarefaId }, "venda incompleta: não consegui comentar o que falta");
    problemas.push("não consegui comentar o que falta na task");
  }

  return { noBacklog, comentou, problemas };
}
