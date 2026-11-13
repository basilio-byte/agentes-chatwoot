import { db } from "@/lib/db";
import { lerComReserva } from "@/lib/leitura-remota";
import { diaEmSaoPaulo } from "@/lib/tempo";
import { abrirClickUp } from "@/server/integrations/clickup/sistema";

import {
  cruzarComAsTarefas,
  lerTarefasDoFluxo,
  tarefasOrfas,
  type ContratoParaCruzar,
  type TarefaDoFluxo,
} from "./clickup";
import {
  diferencaMensal,
  valorAnterior,
  type ContratoDaLeva,
  type ValorAnterior,
} from "./regras";

/**
 * A leitura da tela `/renovacoes`.
 *
 * ⚠⚠ **A tela NÃO abre o Conexa.** A primeira versão lia a leva ao vivo e
 * morria: são dezenas de páginas de `/contracts` (não há filtro por
 * fidelidade), e em 10/11/2026 uma delas passou dos 20 s de prazo do cliente —
 * a tela abriu com zero contratos e um aviso de timeout. Quem lê o Conexa é a
 * rodada diária (`retrato.ts`), que grava o estado de cada contrato da leva em
 * `RetratoDeRenovacao`. Mesma doutrina de `CobrancaFiscal`, que guarda a
 * cobrança lida em vez de reler o ERP a cada abertura.
 *
 * O ClickUp continua ao vivo: são duas idas, e o status da tarefa é o dado que
 * mais muda durante o dia.
 */

const MIN = 60_000;

export type LinhaDaRenovacao = {
  contratoId: number;
  clienteId: number;
  /** O nome vem da tarefa do ClickUp: `GET /contracts` não devolve o do cliente. */
  nome: string | null;
  plano: string | null;
  periodicidade: string | null;
  fidelidade: string | null;
  valor: number | null;
  anterior: ValorAnterior | null;
  /** Diferença por mês, como a planilha calcula (anual dividido por 12). */
  diferenca: number | null;
  reajusteEm: string | null;
  reajustePct: number | null;
  reajusteIndice: string | null;
  tarefa: TarefaDoFluxo | null;
  /** Tarefas do mesmo cliente que não ficaram com este contrato nem com outro da leva. */
  outrasTarefas: number;
  /**
   * Por que o contrato não tem tarefa, quando o cliente TEM tarefas no fluxo:
   * nenhuma tem o valor e a data deste contrato, ou mais de uma serve sem como
   * distinguir. Nulo quando casou, ou quando o cliente não tem tarefa nenhuma
   * (aí o buraco é o "fora do fluxo" de sempre).
   */
  motivoSemTarefa: string | null;
};

export type LevaDaTela = {
  mes: string;
  linhas: LinhaDaRenovacao[];
  atrasados: LinhaDaRenovacao[];
  /** Tarefas no fluxo sem contrato correspondente — o outro lado do buraco. */
  orfas: TarefaDoFluxo[];
  /** Quando a rodada leu o Conexa pela última vez. Nulo = nunca leu. */
  lidoEm: Date | null;
  clickupCompleto: boolean;
  erros: string[];
};

type LinhaGravada = {
  contratoId: number;
  clienteId: number;
  valorCentavos: number;
  reajusteDoRetrato: string | null;
  valorAtualCentavos: number;
  fidelidade: string;
  periodicidade: string | null;
  plano: string | null;
  reajusteEm: string | null;
  reajustePct: number | null;
  reajusteIndice: string | null;
  lidoEm: Date;
};

const CAMPOS = {
  contratoId: true,
  clienteId: true,
  valorCentavos: true,
  reajusteDoRetrato: true,
  valorAtualCentavos: true,
  fidelidade: true,
  periodicidade: true,
  plano: true,
  reajusteEm: true,
  reajustePct: true,
  reajusteIndice: true,
  lidoEm: true,
} as const;

async function tarefasDoFluxo() {
  return lerComReserva("renovacao:tarefas", {
    validadeMs: 5 * MIN,
    idadeMaximaMs: 60 * MIN,
    carregar: async () => {
      const clickup = await abrirClickUp("tela de renovações");
      if ("erro" in clickup) throw new Error(clickup.erro);
      return lerTarefasDoFluxo(clickup.cliente);
    },
  });
}

/** O mês da leva que a tela abre por padrão: o PRÓXIMO, que é o que está em jogo. */
export function levaPadrao(hoje = diaEmSaoPaulo(new Date())) {
  const [ano, mes] = hoje.split("-").map(Number);
  const d = new Date(Date.UTC(ano, mes, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function lerLeva(mes: string): Promise<LevaDaTela> {
  const erros: string[] = [];
  const hoje = diaEmSaoPaulo(new Date());

  const [daVez, vencidos, tarefas] = await Promise.all([
    db.retratoDeRenovacao.findMany({
      where: { leva: mes },
      select: CAMPOS,
      orderBy: { fidelidade: "asc" },
    }),
    db.retratoDeRenovacao.findMany({
      where: { fidelidade: { lt: hoje } },
      select: CAMPOS,
      orderBy: { fidelidade: "asc" },
      take: 200,
    }),
    tarefasDoFluxo().catch((erro: unknown) => {
      erros.push(`tarefas do ClickUp: ${(erro as Error).message}`);
      return { tarefas: [] as TarefaDoFluxo[], completa: false };
    }),
  ]);

  const montar = (linhas: LinhaGravada[]) =>
    cruzarComAsTarefas(linhas.map(comoContrato), tarefas.tarefas).map((l, i) =>
      montarLinha(linhas[i], l.tarefa, l.outrasTarefas.length, l.motivo),
    );

  const cruzamento = cruzarComAsTarefas(daVez.map(comoContrato), tarefas.tarefas);
  const lidoEm = daVez[0]?.lidoEm ?? vencidos[0]?.lidoEm ?? null;

  return {
    mes,
    linhas: montar(daVez),
    atrasados: montar(vencidos),
    orfas: tarefasOrfas(cruzamento, tarefas.tarefas),
    lidoEm,
    clickupCompleto: tarefas.completa,
    erros,
  };
}

/**
 * A linha gravada no formato que `cruzarComAsTarefas` espera. O valor de antes
 * do lote vai junto: é uma das duas pistas que ligam o contrato à tarefa dele
 * quando o cliente tem mais de uma (a outra é a data de reajuste).
 */
function comoContrato(l: LinhaGravada): ContratoParaCruzar {
  const contrato: ContratoDaLeva = {
    id: l.contratoId,
    clienteId: l.clienteId,
    fidelidade: l.fidelidade,
    valor: l.valorAtualCentavos / 100,
    periodicidade: l.periodicidade,
    inicio: null,
    fim: null,
    ativo: true,
    reajusteEm: l.reajusteEm,
    reajustePct: l.reajustePct,
    reajusteIndice: l.reajusteIndice,
    resumo: l.plano,
  };
  const anterior = valorAnterior(contrato, {
    valor: l.valorCentavos / 100,
    reajusteEm: l.reajusteDoRetrato,
  });
  return { ...contrato, antes: anterior?.valor ?? null };
}

function montarLinha(
  l: LinhaGravada,
  tarefa: TarefaDoFluxo | null,
  outrasTarefas: number,
  motivoSemTarefa: string | null,
): LinhaDaRenovacao {
  const contrato = comoContrato(l);
  const anterior = valorAnterior(contrato, {
    valor: l.valorCentavos / 100,
    reajusteEm: l.reajusteDoRetrato,
  });
  const diferenca =
    anterior && contrato.valor != null
      ? diferencaMensal(anterior.valor, contrato.valor, contrato.periodicidade)
      : null;

  return {
    contratoId: l.contratoId,
    clienteId: l.clienteId,
    nome: tarefa?.nome ?? null,
    plano: l.plano,
    periodicidade: l.periodicidade,
    fidelidade: l.fidelidade,
    valor: contrato.valor,
    anterior,
    diferenca,
    reajusteEm: l.reajusteEm,
    reajustePct: l.reajustePct,
    reajusteIndice: l.reajusteIndice,
    tarefa,
    outrasTarefas,
    motivoSemTarefa,
  };
}

/** Os meses que o seletor da tela oferece: três para trás e seis para a frente. */
export function mesesParaEscolher(hoje = diaEmSaoPaulo(new Date())) {
  const [ano, mes] = hoje.split("-").map(Number);
  return Array.from({ length: 10 }, (_, i) => {
    const d = new Date(Date.UTC(ano, mes - 1 - 3 + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}
