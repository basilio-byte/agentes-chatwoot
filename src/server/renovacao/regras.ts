import { somarDias } from "@/lib/tempo";

/**
 * Renovação de contratos — as regras, puras.
 *
 * Pedido do Diego (task 17twvjx0tky, OKR de novembro/2026) e fluxo descrito
 * pela Duda. O que a equipe faz hoje, e o que cada parte passa a ser:
 *
 * - **A leva do mês é a fidelidade do contrato no Conexa** (`fidelityDate`), e
 *   não a `DATA DE REAJUSTE` do ClickUp: essa continua preenchida em cliente
 *   que já saiu (medido em 09/11/2026 — listando dezembro por ela vêm 76
 *   tarefas, várias em `inativo`, e as amostradas não têm contrato ativo).
 *   ⚠ `GET /contracts` **não filtra por fidelidade** — o recorte é aqui.
 * - **O reajuste continua sendo da pessoa.** Ele é aplicado em LOTE, num único
 *   dia por mês, na tela do Conexa (medido: 82 contratos em 23/10/2026 e zero
 *   em qualquer outro dia de outubro; ≥62 em 21/09). A API não tem endpoint de
 *   reajuste e `lastContractualReadjustment.index/percentage` são só de
 *   leitura — o sistema LÊ o que a pessoa aplicou e propaga.
 * - **A fidelidade avança DEPOIS do pagamento** (decisão da equipe, 10/11/2026),
 *   que é quando a tarefa vai para `ongoing`.
 * - ⚠ **Avança 1 ANO, não 365 dias.** O n8n usa +365 num fluxo e +364 noutro; o
 *   +364 faz a data recuar um dia a cada ciclo, e o +365 erra no ano bissexto.
 */

/** Chave das entregas desta capacidade em `WebhookEvent`. */
export const PROVIDER_RENOVACAO = "RENOVACAO";

/**
 * Quantos dias antes da fidelidade a tarefa entra em `renovação`.
 *
 * Medido na produção: a leva de dezembro foi movida em 04/11/2026 e o contrato
 * conferido vence 04/12 — exatamente D-30.
 */
export const DIAS_DE_ANTECEDENCIA = 30;

/**
 * Quantos dias a tarefa fica em `renovação` antes de ir para
 * `notificação renovação` (pedido da equipe em 10/11/2026 — hoje é o Felipe
 * quem faz esse passo à mão).
 *
 * ⚠ **A API do ClickUp não expõe a Atividade**, então não dá para perguntar há
 * quanto tempo a tarefa está no status. Quem marca a entrada é a nossa rodada,
 * na primeira vez que vê a tarefa ali — por isso `vistaEmRenovacaoEm` é
 * parâmetro, e não algo lido do ClickUp.
 */
export const DIAS_EM_RENOVACAO = 2;

/** Os status do ClickUp que compõem o fluxo, na ordem. */
export const STATUS_RENOVACAO = "renovação";
export const STATUS_NOTIFICACAO = "notificação renovação";
export const STATUS_PG_PENDENTE = "pg pendente - renovação";
export const STATUS_ONGOING = "ongoing";
export const STATUS_ONGOING_SALA = "ongoing - sala privativa";

export const STATUS_DO_FLUXO = [
  STATUS_RENOVACAO,
  STATUS_NOTIFICACAO,
  STATUS_PG_PENDENTE,
] as const;

/**
 * Os status de destino que significam **"o cliente continua"** — e só para
 * eles as datas avançam.
 *
 * Lido da automação `Atualizar datas renovação - N8N` no ClickUp (print do
 * usuário em 10/11/2026): o "Para" tem exatamente estes quatro marcados.
 * `😢 distrato`, `negociação`, `inadimplente` e companhia estão FORA — sair do
 * fluxo para um deles não pode empurrar a fidelidade de quem está indo embora.
 */
export const STATUS_QUE_RENOVAM = [
  STATUS_ONGOING,
  STATUS_ONGOING_SALA,
  "seaway",
  "one",
] as const;

/** A troca de status fechou a renovação? */
export function renovou(de: string | null | undefined, para: string | null | undefined) {
  const saiu = STATUS_DO_FLUXO.includes(normalizar(de) as (typeof STATUS_DO_FLUXO)[number]);
  const chegou = STATUS_QUE_RENOVAM.includes(
    normalizar(para) as (typeof STATUS_QUE_RENOVAM)[number],
  );
  return saiu && chegou;
}

/** O ClickUp devolve o status em caixa variada ("ONGOING" na tela, `ongoing` na API). */
function normalizar(status: string | null | undefined) {
  return (status ?? "").trim().toLowerCase();
}

/**
 * Meses de cada periodicidade do Conexa.
 *
 * Serve para a diferença MENSAL da planilha: no plano Anual a equipe divide a
 * diferença por 12 (conferido na aba de fevereiro/2026: 1.363,72 − 1.308 =
 * 55,72, e a planilha mostra 4,6433).
 */
export const MESES_POR_PERIODICIDADE: Record<string, number> = {
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  semester: 6,
  yearly: 12,
};

export type ContratoDaLeva = {
  id: number;
  clienteId: number;
  /** `fidelityDate`, AAAA-MM-DD. */
  fidelidade: string | null;
  /** `amount` de AGORA — depois do lote, já é o valor novo. */
  valor: number | null;
  periodicidade: string | null;
  inicio: string | null;
  fim: string | null;
  ativo: boolean;
  reajusteEm: string | null;
  reajustePct: number | null;
  reajusteIndice: string | null;
  /** Do Conexa, para a tela. Não entram em regra nenhuma. */
  plano?: number | null;
  resumo?: string | null;
  diaDeVencimento?: number | null;
};

/**
 * Os contratos cuja fidelidade cai no mês (`AAAA-MM`).
 *
 * Só ATIVO e só com fidelidade: contrato encerrado não renova, e sem
 * fidelidade não há data para a leva.
 */
export function daLeva<T extends ContratoDaLeva>(contratos: T[], mes: string) {
  return contratos.filter(
    (c) => c.ativo && c.fidelidade?.slice(0, 7) === mes,
  );
}

/** Contratos ativos cuja fidelidade já passou — o atraso que ninguém fechou. */
export function atrasados<T extends ContratoDaLeva>(contratos: T[], hoje: string) {
  return contratos.filter((c) => c.ativo && c.fidelidade && c.fidelidade < hoje);
}

/**
 * O dia em que a tarefa deve entrar em `renovação` (D-30 da fidelidade).
 */
export function diaDeEntrarEmRenovacao(fidelidade: string) {
  return somarDias(fidelidade, -DIAS_DE_ANTECEDENCIA);
}

/**
 * Já passou o tempo de ficar em `renovação`? Então vai para
 * `notificação renovação`.
 *
 * `vistaEmRenovacaoEm` é o dia em que NÓS vimos a tarefa naquele status pela
 * primeira vez — ver a nota de `DIAS_EM_RENOVACAO`.
 */
export function deveNotificar(vistaEmRenovacaoEm: string | null, hoje: string) {
  if (!vistaEmRenovacaoEm) return false;
  return hoje >= somarDias(vistaEmRenovacaoEm, DIAS_EM_RENOVACAO);
}

/**
 * A fidelidade depois da renovação: **mesmo dia, um ano à frente**.
 *
 * ⚠ 29/02 não existe todo ano: cai em 28/02, que é o que o calendário faz.
 * Somar 365 dias (como o n8n faz) erraria num ano bissexto, e somar 364
 * (como o outro fluxo faz) recua um dia por ciclo.
 */
export function fidelidadeRenovada(fidelidade: string, anos = 1) {
  const [ano, mes, dia] = fidelidade.split("-").map(Number);
  const alvo = ano + anos;
  const ultimoDia = new Date(Date.UTC(alvo, mes, 0)).getUTCDate();
  const diaCerto = Math.min(dia, ultimoDia);
  return `${alvo}-${String(mes).padStart(2, "0")}-${String(diaCerto).padStart(2, "0")}`;
}

export type ValorAnterior = {
  valor: number;
  /** De onde saiu — a tela diz qual, porque deduzido não é medido. */
  origem: "retrato" | "deduzido";
};

export type Retrato = {
  /** O valor no dia em que o retrato foi tirado. */
  valor: number;
  /** O reajuste que o contrato JÁ tinha naquele dia. */
  reajusteEm: string | null;
};

/**
 * O retrato vale como "valor anterior"?
 *
 * ⚠ **Só se tiver sido tirado ANTES do lote de reajuste daquela leva.** Se a
 * primeira leitura de um contrato aconteceu depois do lote — porque o sistema
 * subiu no dia 25, ou porque a leva entrou atrasada —, o valor guardado já é o
 * NOVO, e usá-lo como anterior faria a diferença dar zero sem ninguém
 * perceber.
 *
 * Quem denuncia isso é o reajuste: se o que o retrato viu é o MESMO de agora,
 * o lote já tinha acontecido quando lemos.
 */
export function retratoEhAnterior(
  retrato: Retrato,
  contrato: Pick<ContratoDaLeva, "reajusteEm">,
) {
  if (!contrato.reajusteEm) return false; // sem reajuste, não há "anterior"
  return retrato.reajusteEm !== contrato.reajusteEm;
}

/**
 * O valor de antes do reajuste.
 *
 * ⚠ **O Conexa não guarda o valor anterior** — `GET /contract` devolve só o
 * `amount` de agora. Dois caminhos, nesta ordem:
 *
 * 1. **O retrato**: a leva é lida em D-30, ANTES do lote de reajuste, e o valor
 *    daquele dia fica guardado. É exato, e é por isso que a leitura mensal
 *    precisa rodar antes do dia do lote.
 * 2. **Deduzido do percentual** (`valor ÷ (1 + pct/100)`), quando não há
 *    retrato — conferido no cliente 5060: 1.338,62 ÷ 1,0458 = 1.280,00. ⚠ Mente
 *    se alguém negociou um valor fora do reajuste, então a tela diz que foi
 *    deduzido.
 */
export function valorAnterior(
  contrato: Pick<ContratoDaLeva, "valor" | "reajustePct" | "reajusteEm">,
  retrato?: Retrato | null,
): ValorAnterior | null {
  if (retrato && retratoEhAnterior(retrato, contrato)) {
    return { valor: arredondar(retrato.valor), origem: "retrato" };
  }

  const { valor, reajustePct } = contrato;
  if (valor == null || !reajustePct) return null;
  return { valor: arredondar(valor / (1 + reajustePct / 100)), origem: "deduzido" };
}

/**
 * A diferença que a planilha mostra: **por mês**.
 *
 * No plano Mensal é a diferença direta; no Anual, a do ano dividida por 12 —
 * é assim que a equipe compara planos de periodicidades diferentes.
 */
export function diferencaMensal(
  valorAnterior: number,
  valor: number,
  periodicidade: string | null,
) {
  const meses = MESES_POR_PERIODICIDADE[(periodicidade ?? "").toLowerCase()] ?? 1;
  return (valor - valorAnterior) / meses;
}

function arredondar(n: number) {
  return Math.round(n * 100) / 100;
}
