import { db } from "@/lib/db";
import { lerComReserva } from "@/lib/leitura-remota";
import { diaEmSaoPaulo } from "@/lib/tempo";
import { abrirClickUp } from "@/server/integrations/clickup/sistema";
import { abrirConexa } from "@/server/integrations/conexa/sistema";

import {
  cruzarComAsTarefas,
  lerTarefasDoFluxo,
  tarefasOrfas,
  type TarefaDoFluxo,
} from "./clickup";
import { lerContratosAtivos } from "./conexa";
import {
  atrasados,
  daLeva,
  diferencaMensal,
  valorAnterior,
  type ContratoDaLeva,
  type ValorAnterior,
} from "./regras";

/**
 * A leitura da tela `/renovacoes`.
 *
 * ⚠ **Passa por `lerComReserva`**, como a tela de Integrações: ler a leva custa
 * ~14 idas ao Conexa (não há filtro por fidelidade) e a listagem do ClickUp mais
 * duas. Sem isso, cada abertura da tela — e cada troca de mês — esperaria tudo
 * de novo. Quem abre recebe o último valor lido na hora e a renovação vai por
 * trás.
 *
 * ⚠ **Leitura incompleta é dita, nunca escondida.** A tela precisa poder
 * afirmar "a leva de dezembro tem 66 contratos"; com a lista cortada, esse
 * número seria mentira — e os contratos que faltam são justamente os que
 * ninguém renovou.
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
  outrasTarefas: number;
};

export type LevaDaTela = {
  mes: string;
  linhas: LinhaDaRenovacao[];
  atrasados: LinhaDaRenovacao[];
  /** Tarefas no fluxo sem contrato ativo correspondente — o outro lado do buraco. */
  orfas: TarefaDoFluxo[];
  conexaCompleto: boolean;
  clickupCompleto: boolean;
  erros: string[];
};

type Fontes = {
  contratos: ContratoDaLeva[];
  conexaCompleto: boolean;
  tarefas: TarefaDoFluxo[];
  clickupCompleto: boolean;
  erros: string[];
};

async function lerFontes(): Promise<Fontes> {
  const erros: string[] = [];

  const [contratos, tarefas] = await Promise.all([
    lerComReserva("renovacao:contratos", {
      validadeMs: 10 * MIN,
      idadeMaximaMs: 6 * 60 * MIN,
      carregar: async () => {
        const conexa = await abrirConexa("tela de renovações");
        if ("erro" in conexa) throw new Error(conexa.erro);
        return lerContratosAtivos(conexa.cliente);
      },
      // Lista vazia por erro não pode substituir a boa e ficar 10 min no lugar dela.
      deveGuardar: (r) => r.contratos.length > 0,
    }).catch((erro: unknown) => {
      erros.push(`contratos do Conexa: ${(erro as Error).message}`);
      return { contratos: [] as ContratoDaLeva[], completa: false, paginas: 0 };
    }),

    lerComReserva("renovacao:tarefas", {
      validadeMs: 5 * MIN,
      idadeMaximaMs: 60 * MIN,
      carregar: async () => {
        const clickup = await abrirClickUp("tela de renovações");
        if ("erro" in clickup) throw new Error(clickup.erro);
        return lerTarefasDoFluxo(clickup.cliente);
      },
    }).catch((erro: unknown) => {
      erros.push(`tarefas do ClickUp: ${(erro as Error).message}`);
      return { tarefas: [] as TarefaDoFluxo[], completa: false };
    }),
  ]);

  return {
    contratos: contratos.contratos,
    conexaCompleto: contratos.completa,
    tarefas: tarefas.tarefas,
    clickupCompleto: tarefas.completa,
    erros,
  };
}

/** O mês da leva que a tela abre por padrão: o PRÓXIMO, que é o que está em jogo. */
export function levaPadrao(hoje = diaEmSaoPaulo(new Date())) {
  const [ano, mes] = hoje.split("-").map(Number);
  const d = new Date(Date.UTC(ano, mes, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function lerLeva(mes: string): Promise<LevaDaTela> {
  const fontes = await lerFontes();
  const hoje = diaEmSaoPaulo(new Date());

  const daVez = daLeva(fontes.contratos, mes);
  const emAtraso = atrasados(fontes.contratos, hoje);

  const retratos = await lerRetratos([...daVez, ...emAtraso]);
  const montar = (contratos: ContratoDaLeva[]) =>
    cruzarComAsTarefas(contratos, fontes.tarefas).map((l) =>
      montarLinha(l.contrato, l.tarefa, l.outrasTarefas.length, retratos),
    );

  const linhas = montar(daVez);
  const cruzamento = cruzarComAsTarefas(daVez, fontes.tarefas);

  return {
    mes,
    linhas,
    atrasados: montar(emAtraso),
    orfas: tarefasOrfas(cruzamento, fontes.tarefas),
    conexaCompleto: fontes.conexaCompleto,
    clickupCompleto: fontes.clickupCompleto,
    erros: fontes.erros,
  };
}

type RetratoLido = { valor: number; reajusteEm: string | null };

async function lerRetratos(contratos: ContratoDaLeva[]) {
  const ids = contratos.map((c) => c.id);
  if (!ids.length) return new Map<number, RetratoLido>();

  const linhas = await db.retratoDeRenovacao.findMany({
    where: { contratoId: { in: ids } },
    select: { contratoId: true, valorCentavos: true, reajusteEm: true },
  });

  return new Map(
    linhas.map((l) => [
      l.contratoId,
      { valor: l.valorCentavos / 100, reajusteEm: l.reajusteEm },
    ]),
  );
}

function montarLinha(
  contrato: ContratoDaLeva,
  tarefa: TarefaDoFluxo | null,
  outrasTarefas: number,
  retratos: Map<number, RetratoLido>,
): LinhaDaRenovacao {
  const anterior = valorAnterior(contrato, retratos.get(contrato.id));
  const diferenca =
    anterior && contrato.valor != null
      ? diferencaMensal(anterior.valor, contrato.valor, contrato.periodicidade)
      : null;

  return {
    contratoId: contrato.id,
    clienteId: contrato.clienteId,
    nome: tarefa?.nome ?? null,
    plano: contrato.resumo ?? null,
    periodicidade: contrato.periodicidade,
    fidelidade: contrato.fidelidade,
    valor: contrato.valor,
    anterior,
    diferenca,
    reajusteEm: contrato.reajusteEm,
    reajustePct: contrato.reajustePct,
    reajusteIndice: contrato.reajusteIndice,
    tarefa,
    outrasTarefas,
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
