import type { ClickUpClient } from "@/server/integrations/clickup/client";
import type { ClickUpTarefa } from "@/server/integrations/clickup/tipos";

import { STATUS_DO_FLUXO, type ContratoDaLeva } from "./regras";

/**
 * O lado ClickUp da renovação: achar, na Base de clientes, a tarefa de cada
 * contrato da leva.
 *
 * ⚠ **A chave é o id do cliente no Conexa, e ele mora no NOME da tarefa.** A
 * equipe nomeia como `(5077) RAZÃO SOCIAL` (e a planilha, como
 * `5077 - RAZÃO SOCIAL`). O campo `Customer Id` existe na lista, mas está
 * vazio na maioria das tarefas que conferi; o `CONEXA LINK` tem o id na query
 * e é a fonte mais confiável quando está preenchido.
 *
 * ⚠ **Não se lista a Base inteira.** São mais de mil tarefas; o que a tela
 * precisa é das que estão nos três status do fluxo (123 em 09/11/2026).
 * Contrato da leva sem tarefa nesses status aparece como "fora do fluxo", que
 * é justamente o que se quer ver.
 */

/** "Base de clientes", no space SEAHUB. A mesma lista do aviso de cobrança. */
export const LISTA_BASE_DE_CLIENTES = "900701122530";

/** Teto de páginas da listagem (100 por página). */
export const PAGINAS_MAXIMAS = 10;

/**
 * O id do cliente no Conexa a partir da tarefa.
 *
 * O link vence o nome: alguém pode renomear a tarefa, e o `(1061)` do fim de
 * `(2919) EVOLUA NORDESTE SPE S.A. (1058)` mostra que o nome tem mais de um
 * número entre parênteses — por isso o nome só vale no COMEÇO.
 */
export function idDoClienteNaTarefa(nome: string, linkConexa?: string | null) {
  const doLink = linkConexa?.match(/[?&]idCliente=(\d{1,7})\b/);
  if (doLink) return Number(doLink[1]);

  const texto = (nome ?? "").trimStart();
  const entreParenteses = texto.match(/^\((\d{1,7})\)/);
  if (entreParenteses) return Number(entreParenteses[1]);

  // Formato da planilha: `5077 - RAZÃO SOCIAL`. O travessão é obrigatório para
  // não confundir um nome que comece com ano ("2026 Planejamento").
  const comTravessao = texto.match(/^(\d{1,7})\s*[-–]\s/);
  if (comTravessao) return Number(comTravessao[1]);

  return null;
}

export type TarefaDoFluxo = {
  id: string;
  nome: string;
  status: string;
  url?: string;
  clienteId: number | null;
  atualizadaEm: Date | null;
};

function emData(ms?: string | null) {
  if (!ms) return null;
  const n = Number(ms);
  return Number.isFinite(n) ? new Date(n) : null;
}

export function tarefaDoFluxo(tarefa: ClickUpTarefa, linkConexa?: string | null): TarefaDoFluxo {
  return {
    id: tarefa.id,
    nome: (tarefa.name ?? "").trim(),
    status: tarefa.status?.status ?? "",
    url: tarefa.url,
    clienteId: idDoClienteNaTarefa(tarefa.name ?? "", linkConexa),
    atualizadaEm: emData(tarefa.date_updated),
  };
}

export type LeituraDasTarefas = {
  tarefas: TarefaDoFluxo[];
  completa: boolean;
};

/** As tarefas da Base de clientes que estão nos três status da renovação. */
export async function lerTarefasDoFluxo(
  cliente: Pick<ClickUpClient, "listarTarefasDaLista">,
  listaId = LISTA_BASE_DE_CLIENTES,
): Promise<LeituraDasTarefas> {
  const tarefas: TarefaDoFluxo[] = [];

  for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina++) {
    const { tasks } = await cliente.listarTarefasDaLista(listaId, {
      statuses: [...STATUS_DO_FLUXO],
      page: pagina,
    });

    for (const t of tasks) tarefas.push(tarefaDoFluxo(t));

    // A API devolve 100 por página; página incompleta é o fim da lista. Parar
    // pelo total não serve: ele muda enquanto se lê.
    if (tasks.length < 100) return { tarefas, completa: true };
  }

  return { tarefas, completa: false };
}

export type LinhaDaLeva = {
  contrato: ContratoDaLeva;
  tarefa: TarefaDoFluxo | null;
  /** Mais de uma tarefa do mesmo cliente nos status do fluxo. */
  outrasTarefas: TarefaDoFluxo[];
};

/**
 * Junta a leva do Conexa com as tarefas do fluxo, pelo id do cliente.
 *
 * ⚠ **Um cliente pode ter mais de uma tarefa** (vi um com quatro no mesmo
 * status). A primeira vai em `tarefa` e as demais em `outrasTarefas`, em vez
 * de escolher uma em silêncio — duas tarefas para o mesmo contrato é um
 * problema de cadastro que a tela tem de mostrar.
 */
export function cruzarComAsTarefas(
  contratos: ContratoDaLeva[],
  tarefas: TarefaDoFluxo[],
): LinhaDaLeva[] {
  const porCliente = new Map<number, TarefaDoFluxo[]>();
  for (const t of tarefas) {
    if (t.clienteId === null) continue;
    const lista = porCliente.get(t.clienteId) ?? [];
    lista.push(t);
    porCliente.set(t.clienteId, lista);
  }

  return contratos.map((contrato) => {
    const [primeira, ...demais] = porCliente.get(contrato.clienteId) ?? [];
    return { contrato, tarefa: primeira ?? null, outrasTarefas: demais };
  });
}

/** Tarefas no fluxo que não casaram com contrato nenhum da leva. */
export function tarefasOrfas(linhas: LinhaDaLeva[], tarefas: TarefaDoFluxo[]) {
  const usadas = new Set(
    linhas.flatMap((l) => [l.tarefa?.id, ...l.outrasTarefas.map((t) => t.id)]),
  );
  return tarefas.filter((t) => !usadas.has(t.id));
}
