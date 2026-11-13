import type { ClickUpClient } from "@/server/integrations/clickup/client";
import { deTimestamp } from "@/server/integrations/clickup/datas";
import type { ClickUpTarefa } from "@/server/integrations/clickup/tipos";

import { casarContratosComTarefas, type TarefaParaCasar } from "./casamento";
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

/** `VALOR CONTRATO` (currency) e `DATA DE REAJUSTE` (date) da Base de clientes. */
export const CAMPO_VALOR_DA_TAREFA = "0dad1007-feb0-437a-9051-87bbac539d4c";
export const CAMPO_DATA_DE_REAJUSTE = "0231d769-5063-439d-8b03-ad660c6bada5";

export type TarefaDoFluxo = {
  id: string;
  nome: string;
  status: string;
  url?: string;
  clienteId: number | null;
  atualizadaEm: Date | null;
  /**
   * `VALOR CONTRATO` e `DATA DE REAJUSTE`, lidos da própria listagem: são o que
   * liga a tarefa ao contrato dela quando o cliente tem mais de uma. Ausentes
   * (ou nulos) nas tarefas antigas.
   */
  valor?: number | null;
  dataDeReajuste?: string | null;
};

function emData(ms?: string | null) {
  if (!ms) return null;
  const n = Number(ms);
  return Number.isFinite(n) ? new Date(n) : null;
}

function campoDaTarefa(tarefa: ClickUpTarefa, id: string) {
  return tarefa.custom_fields?.find((c) => c.id === id)?.value;
}

function valorDaTarefa(tarefa: ClickUpTarefa): number | null {
  const bruto = campoDaTarefa(tarefa, CAMPO_VALOR_DA_TAREFA);
  if (bruto == null || bruto === "") return null;
  const n = Number(bruto);
  return Number.isFinite(n) ? n : null;
}

function dataDeReajusteDaTarefa(tarefa: ClickUpTarefa): string | null {
  const bruto = campoDaTarefa(tarefa, CAMPO_DATA_DE_REAJUSTE);
  if (bruto == null || bruto === "") return null;
  return deTimestamp(String(bruto));
}

export function tarefaDoFluxo(tarefa: ClickUpTarefa, linkConexa?: string | null): TarefaDoFluxo {
  return {
    id: tarefa.id,
    nome: (tarefa.name ?? "").trim(),
    status: tarefa.status?.status ?? "",
    url: tarefa.url,
    clienteId: idDoClienteNaTarefa(tarefa.name ?? "", linkConexa),
    atualizadaEm: emData(tarefa.date_updated),
    valor: valorDaTarefa(tarefa),
    dataDeReajuste: dataDeReajusteDaTarefa(tarefa),
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

/** Um contrato da leva, com o valor de antes do lote quando se sabe. */
export type ContratoParaCruzar = ContratoDaLeva & { antes?: number | null };

export type LinhaDaLeva = {
  contrato: ContratoDaLeva;
  tarefa: TarefaDoFluxo | null;
  /**
   * Tarefas do MESMO cliente, nos status do fluxo, que não ficaram com este
   * contrato nem com outro da leva — as que sobram, ou as que servem a mais de
   * um contrato sem como distinguir.
   */
  outrasTarefas: TarefaDoFluxo[];
  /** Por que o contrato não tem tarefa, quando o cliente TEM tarefas. */
  motivo: string | null;
};

function paraCasar(t: TarefaDoFluxo): TarefaParaCasar {
  return {
    id: t.id,
    valor: t.valor ?? null,
    dataDeReajuste: t.dataDeReajuste ?? null,
    status: t.status,
  };
}

/**
 * Junta a leva do Conexa com as tarefas do fluxo.
 *
 * O cliente é a primeira chave (id no nome da tarefa). Dentro do cliente, o
 * casamento é por CONTRATO: cada tarefa é o contrato de um produto, e quem tem
 * quatro tarefas tem quatro contratos (ver `casamento.ts`). O que não casa com
 * segurança fica sem tarefa, com o motivo escrito, em vez de receber a primeira
 * da lista em silêncio.
 */
export function cruzarComAsTarefas(
  contratos: ContratoParaCruzar[],
  tarefas: TarefaDoFluxo[],
): LinhaDaLeva[] {
  const porCliente = new Map<number, TarefaDoFluxo[]>();
  for (const t of tarefas) {
    if (t.clienteId === null) continue;
    const lista = porCliente.get(t.clienteId) ?? [];
    lista.push(t);
    porCliente.set(t.clienteId, lista);
  }

  const contratosPorCliente = new Map<number, ContratoParaCruzar[]>();
  for (const c of contratos) {
    const lista = contratosPorCliente.get(c.clienteId) ?? [];
    lista.push(c);
    contratosPorCliente.set(c.clienteId, lista);
  }

  type Resultado = { tarefa: TarefaDoFluxo | null; motivo: string | null };
  const dosContratos = new Map<number, Resultado>();
  const pareadas = new Map<number, Set<string>>();

  for (const [clienteId, doCliente] of contratosPorCliente) {
    const tarefasDoCliente = porCliente.get(clienteId) ?? [];
    const porId = new Map(tarefasDoCliente.map((t) => [t.id, t]));
    const casamento = casarContratosComTarefas(
      doCliente.map((c) => ({
        id: c.id,
        fidelidade: c.fidelidade,
        antes: c.antes ?? null,
        atual: c.valor,
        assinatura: `${c.antes ?? "?"}|${c.valor ?? "?"}|${c.fidelidade ?? "?"}|${c.reajusteEm ?? "?"}|${c.reajustePct ?? "?"}`,
      })),
      tarefasDoCliente.map(paraCasar),
    );

    const usadas = pareadas.get(clienteId) ?? new Set<string>();
    for (const par of casamento.pares) {
      dosContratos.set(par.contrato.id, { tarefa: porId.get(par.tarefa.id) ?? null, motivo: null });
      usadas.add(par.tarefa.id);
    }
    for (const { contrato, motivo } of [...casamento.semTarefa, ...casamento.ambiguos]) {
      // Sem tarefa nenhuma do cliente, o buraco é o "fora do fluxo" de sempre,
      // e não precisa de motivo.
      dosContratos.set(contrato.id, {
        tarefa: null,
        motivo: tarefasDoCliente.length ? motivo : null,
      });
    }
    pareadas.set(clienteId, usadas);
  }

  return contratos.map((contrato) => {
    const resultado = dosContratos.get(contrato.id);
    const usadas = pareadas.get(contrato.clienteId) ?? new Set<string>();
    const outras = (porCliente.get(contrato.clienteId) ?? []).filter((t) => !usadas.has(t.id));
    return {
      contrato,
      tarefa: resultado?.tarefa ?? null,
      outrasTarefas: outras,
      motivo: resultado?.motivo ?? null,
    };
  });
}

/** Tarefas no fluxo que não casaram com contrato nenhum da leva. */
export function tarefasOrfas(linhas: LinhaDaLeva[], tarefas: TarefaDoFluxo[]) {
  const usadas = new Set(
    linhas.flatMap((l) => [l.tarefa?.id, ...l.outrasTarefas.map((t) => t.id)]),
  );
  return tarefas.filter((t) => !usadas.has(t.id));
}
