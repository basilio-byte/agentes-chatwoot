import { diaEmSaoPaulo } from "@/lib/tempo";

import { TOLERANCIA_DE_DIAS, casarContratosComTarefas } from "./casamento";
import { diasEntre } from "./notificacao";
import { STATUS_QUE_RENOVAM, fidelidadeRenovada } from "./regras";

/**
 * Fase 3: avançar as datas da renovação — o que o fluxo do n8n "Atualizar datas
 * do processo de renovação ClickUp/Conexa" faz hoje, a partir da automação 8 do
 * ClickUp (tarefa que sai de `notificação`/`pg pendente` para um dos quatro
 * status de continuidade).
 *
 * ## O que o n8n faz, lido do fluxo (16/11/2026)
 *
 * 1. `DATA DE ENCERRAMENTO CONTRATO [BASE CLIENTES]` da tarefa = o valor que a
 *    automação mandou na URL (`dataencerramento`) **+ 365 dias**;
 * 2. `DATA DE REAJUSTE` = `datadereajuste` **+ 365 dias**;
 * 3. `PATCH /contract/<id> { fidelityDate }` = a fidelidade do contrato + 365 dias
 *    — só do **primeiro** contrato do cliente (`data[0]`), e só se o nome do plano
 *    contém o `tipodeproduto` da tarefa.
 *
 * ## O que muda aqui, e por quê
 *
 * - **+1 ANO, não +365 dias** (`fidelidadeRenovada`): +365 erra no ano bissexto e
 *   o +364 do outro fluxo recua um dia por ciclo.
 * - **O contrato é o DA TAREFA** (casamento por valor e data, `casamento.ts`), não
 *   o primeiro da lista: cada tarefa é o contrato de um produto, e quem tem
 *   quatro contratos tem quatro tarefas, cada uma avançando o seu. O fluxo antigo
 *   deixava os outros três para trás.
 * - **Sem o LLM**: o n8n usava um modelo só para tirar o `idCliente` de uma URL.
 * - **Idempotente**: a entrega repetida não avança duas vezes (reserva por
 *   tarefa e data, mais um freio por tarefa por dia).
 * - **Lê o contrato de volta** depois de escrever no Conexa.
 *
 * ⚠⚠ **A `DATA DE ENCERRAMENTO` é escrita por DOIS caminhos** (a automação 9 do
 * ClickUp grava "hoje + 365" e o n8n gravava "valor antigo + 365", e quem chega
 * por último vence). Aqui o comportamento do n8n é mantido — valor antigo + 1 ano —
 * porque a decisão de qual conta vale é da equipe, e mudar o resultado
 * escondido numa migração seria pior do que migrar igual.
 */

const MESES: Record<string, number> = {
  jan: 1, feb: 2, fev: 2, mar: 3, apr: 4, abr: 4, may: 5, mai: 5, jun: 6,
  jul: 7, aug: 8, ago: 8, sep: 9, set: 9, oct: 10, out: 10, nov: 11, dec: 12, dez: 12,
};

function dia(ano: number, mes: number, d: number) {
  const data = new Date(Date.UTC(ano, mes - 1, d));
  if (data.getUTCFullYear() !== ano || data.getUTCMonth() !== mes - 1 || data.getUTCDate() !== d) {
    return null;
  }
  return `${ano}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Uma data como o ClickUp a escreve numa URL de automação, em `AAAA-MM-DD`.
 *
 * O n8n esperava `MMM DD YYYY` ("Sep 24 2025"). Aceita também ISO, `DD/MM/AAAA`
 * e milissegundos (o formato do próprio campo), porque a automação pode ser
 * reconfigurada e a data que não for entendida não pode virar chute.
 */
export function lerDataDoClickUp(texto: string | null | undefined): string | null {
  const t = (texto ?? "").trim();
  if (!t) return null;

  if (/^\d{12,13}$/.test(t)) return diaEmSaoPaulo(new Date(Number(t)));

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(t);
  if (iso) return dia(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (br) return dia(Number(br[3]), Number(br[2]), Number(br[1]));

  const mmm = /^([A-Za-zçÇ]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  if (mmm) {
    const mes = MESES[mmm[1].toLowerCase()];
    return mes ? dia(Number(mmm[3]), mes, Number(mmm[2])) : null;
  }
  return null;
}

export type PedidoDasDatas = {
  tarefaId: string | null;
  /** `datadereajuste` da URL: o valor ANTES de a automação 9 mexer em qualquer coisa. */
  dataReajuste: string | null;
  dataEncerramento: string | null;
};

/** Os campos de data da Base de clientes, como vêm na tarefa do `payload`. */
const CAMPO_REAJUSTE_NO_PAYLOAD = "0231d769-5063-439d-8b03-ad660c6bada5";
const CAMPO_ENCERRAMENTO_NO_PAYLOAD = "885c7420-baa9-4125-95cd-53934b47b147";

/**
 * Texto que é variável do ClickUp NÃO preenchida (`{Task ID}`) não é valor.
 *
 * ⚠ A ação nova "Webhook de chamada" (24/11/2026) escolhe um webhook cadastrado e
 * não troca as variáveis do endereço: `?taskid={Task ID}` chega como o texto
 * `{Task ID}`. Lido como id, ele recusava a chamada inteira.
 */
function valorDe(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && !/[{}]/.test(t) ? t : null;
}

/** O valor de um campo personalizado na tarefa do `payload`, nos dois formatos do ClickUp. */
function campoDoPayload(tarefa: Record<string, unknown>, campoId: string): string | null {
  for (const lista of [tarefa.fields, tarefa.custom_fields]) {
    if (!Array.isArray(lista)) continue;
    for (const campo of lista as Array<Record<string, unknown>>) {
      if (campo?.field_id === campoId || campo?.id === campoId) return valorDe(campo.value);
    }
  }
  return null;
}

/**
 * O que a automação mandou. Só o id da tarefa é indispensável; as duas datas
 * valem como "o valor de antes" quando vêm, e a tarefa é relida ao vivo quando
 * não vêm.
 *
 * Os nomes aceitos incluem os do n8n (`taskid`, `datadereajuste`,
 * `dataencerramento`) e as variações óbvias, no query e no corpo: o ClickUp
 * chama o endereço por POST e o formato do corpo não é documentado.
 *
 * ⚠⚠ **A automação do ClickUp manda a TAREFA dentro de `payload`, e o `id` do
 * topo é da EXECUÇÃO da automação, não da tarefa** (conferido nas entregas reais
 * dos gatilhos em 24/11/2026: `{ id | auto_id, trigger_id, date, payload }`). Por
 * isso o id vem do query, depois de `payload.id`, e o `id` do topo só vale quando
 * não há `payload` nenhum. As datas também podem vir dos campos da tarefa no
 * `payload` (`fields` na ação nova, `custom_fields` na antiga): é a foto do
 * momento da troca de status, antes de qualquer automação regravar.
 */
export function lerPedidoDasDatas(
  query: Record<string, string | null | undefined>,
  corpo: unknown,
): PedidoDasDatas {
  const doCorpo = (corpo && typeof corpo === "object" ? corpo : {}) as Record<string, unknown>;
  const temPayload = !!doCorpo.payload && typeof doCorpo.payload === "object";
  const tarefa = (temPayload ? doCorpo.payload : {}) as Record<string, unknown>;

  const achar = (fontes: Array<Record<string, unknown>>, ...nomes: string[]) => {
    for (const fonte of fontes) {
      for (const n of nomes) {
        const v = valorDe(fonte[n]);
        if (v) return v;
      }
    }
    return null;
  };
  const daQuery = query as Record<string, unknown>;

  const id =
    achar([daQuery, doCorpo, tarefa], "taskid", "taskId", "task_id") ??
    achar([tarefa], "id") ??
    (temPayload ? null : achar([doCorpo], "id"));

  return {
    tarefaId: id && /^[A-Za-z0-9_-]{4,40}$/.test(id) ? id : null,
    dataReajuste: lerDataDoClickUp(
      achar([daQuery, doCorpo, tarefa], "datadereajuste", "dataReajuste", "data_de_reajuste") ??
        campoDoPayload(tarefa, CAMPO_REAJUSTE_NO_PAYLOAD),
    ),
    dataEncerramento: lerDataDoClickUp(
      achar([daQuery, doCorpo, tarefa], "dataencerramento", "dataEncerramento", "data_de_encerramento") ??
        campoDoPayload(tarefa, CAMPO_ENCERRAMENTO_NO_PAYLOAD),
    ),
  };
}

export type TarefaParaDatas = {
  id: string;
  status: string;
  valor: number | null;
  dataDeReajuste: string | null;
  dataDeEncerramento: string | null;
};

export type ContratoParaDatas = {
  id: number;
  fidelidade: string | null;
  valor: number | null;
  /** O valor de antes do lote, quando o retrato o tem. */
  antes: number | null;
  ativo: boolean;
};

export type PlanoDasDatas =
  | { aplicavel: false; motivo: string }
  | {
      aplicavel: true;
      /** A data de reajuste da qual se parte, e de onde sai a chave da reserva. */
      baseDoReajuste: string;
      reajusteNovo: string;
      escreverReajuste: boolean;
      encerramentoNovo: string | null;
      escreverEncerramento: boolean;
      contrato: { id: number; fidelidadeAtual: string; fidelidadeNova: string } | null;
      /** Por que o Conexa não é tocado, quando não é. */
      semContrato: string | null;
      avisos: string[];
    };

/** A tarefa já está em um dos status de "o cliente continua"? */
export function statusDeContinuidade(status: string | null | undefined) {
  const s = (status ?? "").trim().toLowerCase();
  return (STATUS_QUE_RENOVAM as readonly string[]).includes(s);
}

/**
 * Até quantos dias À FRENTE de hoje a fidelidade de um contrato ainda é "do
 * ciclo que está renovando agora". A tarefa vai para `ongoing` quando o cliente
 * paga, que é perto da fidelidade (às vezes um pouco antes, às vezes meses
 * depois); um contrato já avançado está ~1 ano à frente. Sessenta dias separam
 * os dois com folga.
 */
export const DIAS_A_FRENTE_DO_CICLO = 60;

function mesmoValor(a: number | null, b: number | null) {
  return a != null && b != null && Math.round(a * 100) === Math.round(b * 100);
}

/**
 * O que fazer com as datas. Pura: recebe o que foi lido e devolve o plano.
 *
 * Tudo o que for dúvida vira aviso ou `semContrato`, nunca escrita: a data
 * errada de um contrato empurra a renovação de um cliente para o ano errado.
 *
 * ⚠⚠ **A DATA DE REAJUSTE nova sai da FIDELIDADE do Conexa, não da data da
 * tarefa** (24/11/2026). O n8n faz "data da URL + 365", e a primeira versão daqui
 * copiou isso com +1 ano. No dia do lote de dezembro alguém gravou, numa ação em
 * massa, 01/12/2027 na DATA DE REAJUSTE de 51 tarefas do fluxo — e "data da
 * tarefa + 1 ano" daria 2028: o aviso de 30 dias da renovação de 2027 nunca
 * dispararia. O Conexa é a fonte da verdade (é a fidelidade que a Duda atualiza
 * e a que a leva lê), então, achado o contrato da tarefa, a data da tarefa vira a
 * fidelidade NOVA dele. De quebra some a deriva de um dia que os dois fluxos do
 * n8n (+364 e +365) deixaram (contrato 3713: tarefa 10/12, Conexa 11/12).
 *
 * O contrato é achado em dois passos:
 * 1. pela fidelidade perto da data de partida (± `TOLERANCIA_DE_DIAS`), como
 *    sempre — e o casamento por valor desempata;
 * 2. ⚠ se nenhum contrato tem a fidelidade perto da data (a data da tarefa está
 *    errada), pelo VALOR, só entre os contratos do ciclo de agora (fidelidade até
 *    `DIAS_A_FRENTE_DO_CICLO` dias à frente — o já avançado fica de fora) e só
 *    quando todos os que batem são equivalentes. Sem `hoje`, este passo não roda.
 *
 * Sem contrato (tarefa da ONE, cliente sem contrato ativo), vale o de antes —
 * data da tarefa + 1 ano —, com uma trava nova: data de partida mais de
 * `DIAS_A_FRENTE_DO_CICLO` dias no futuro não é empurrada mais um ano.
 */
export function planejarDatas(entrada: {
  tarefa: TarefaParaDatas;
  pedido: PedidoDasDatas;
  contratos: ContratoParaDatas[];
  /** O dia de hoje (AAAA-MM-DD, São Paulo). Liga o passo 2 e a trava de data futura. */
  hoje?: string;
}): PlanoDasDatas {
  const { tarefa, pedido, contratos, hoje } = entrada;

  if (!statusDeContinuidade(tarefa.status)) {
    return {
      aplicavel: false,
      motivo: `a tarefa está em "${tarefa.status}": as datas só avançam quando o cliente continua (${STATUS_QUE_RENOVAM.join(", ")})`,
    };
  }

  const base = pedido.dataReajuste ?? tarefa.dataDeReajuste;
  if (!base) {
    return { aplicavel: false, motivo: "sem DATA DE REAJUSTE: não há de onde avançar" };
  }

  const avisos: string[] = [];

  let encerramentoNovo: string | null = null;
  let escreverEncerramento = false;
  if (pedido.dataEncerramento) {
    encerramentoNovo = fidelidadeRenovada(pedido.dataEncerramento);
    escreverEncerramento = tarefa.dataDeEncerramento !== encerramentoNovo;
  } else {
    avisos.push(
      "a chamada não trouxe a DATA DE ENCERRAMENTO: fica a que a automação do ClickUp gravou",
    );
  }

  const ativos = contratos.filter((c) => c.ativo && c.fidelidade);
  let contrato: { id: number; fidelidadeAtual: string; fidelidadeNova: string } | null = null;
  let semContrato: string | null = null;
  const comFidelidade = (c: ContratoParaDatas) => ({
    id: c.id,
    fidelidadeAtual: c.fidelidade as string,
    fidelidadeNova: fidelidadeRenovada(c.fidelidade as string),
  });

  // Passo 1: a fidelidade em torno da data de partida.
  // ⚠ A exigência de data é mais dura que a do casamento comum, de propósito: o
  // contrato que o valor sozinho explicaria pode já ter sido avançado, e
  // avançá-lo de novo escreveria o ano errado no Conexa.
  const pertoDaData = ativos
    .filter((c) => Math.abs(diasEntre(base, c.fidelidade as string)) <= TOLERANCIA_DE_DIAS)
    .sort((a, b) => a.id - b.id);

  if (pertoDaData.length) {
    const casamento = casarContratosComTarefas(
      pertoDaData.map((c) => ({
        id: c.id,
        fidelidade: c.fidelidade,
        antes: c.antes,
        atual: c.valor,
        // Contratos que só diferem no id escrevem a mesma data: equivalentes.
        assinatura: `${c.antes ?? "?"}|${c.valor ?? "?"}|${c.fidelidade}`,
      })),
      [{ id: tarefa.id, valor: tarefa.valor, dataDeReajuste: base, status: tarefa.status }],
    );
    const par = casamento.pares[0];
    if (par) {
      const escolhido = pertoDaData.find((c) => c.id === par.contrato.id) as ContratoParaDatas;
      contrato = comFidelidade(escolhido);
    } else {
      semContrato =
        casamento.ambiguos[0]?.motivo ??
        casamento.semTarefa[0]?.motivo ??
        "não consegui ligar a tarefa a um contrato do cliente";
    }
  } else {
    // Passo 2: a data da tarefa não bate com contrato nenhum. Pelo valor, só no
    // ciclo de agora, e só sem dúvida.
    const doCiclo = hoje
      ? ativos.filter((c) => diasEntre(hoje, c.fidelidade as string) <= DIAS_A_FRENTE_DO_CICLO)
      : [];
    const peloValor = doCiclo
      .filter((c) => mesmoValor(tarefa.valor, c.valor) || mesmoValor(tarefa.valor, c.antes))
      .sort((a, b) => a.id - b.id);
    const assinaturas = new Set(peloValor.map((c) => `${c.antes ?? "?"}|${c.valor ?? "?"}|${c.fidelidade}`));

    if (peloValor.length && assinaturas.size === 1) {
      contrato = comFidelidade(peloValor[0]);
      avisos.push(
        `a DATA DE REAJUSTE de partida (${formatar(base)}) não bate com a fidelidade de nenhum contrato do cliente; o contrato ${contrato.id} foi ligado pelo valor (fidelidade ${formatar(contrato.fidelidadeAtual)}), e a data da tarefa passa a ser a fidelidade nova dele`,
      );
    } else if (assinaturas.size > 1) {
      semContrato = `a DATA DE REAJUSTE da tarefa (${formatar(base)}) não bate com nenhum contrato, e ${peloValor.length} contratos do cliente têm o valor dela — a equipe precisa indicar qual é`;
    } else {
      semContrato = `nenhum contrato ativo do cliente tem a fidelidade perto de ${base} (já foi avançada, ou o cliente não tem contrato ativo)`;
    }
  }

  let reajusteNovo: string;
  let escreverReajuste: boolean;
  if (contrato) {
    // A fidelidade nova é a verdade; escrever o mesmo valor de novo não faz mal,
    // e um valor diferente (deriva, data em massa) é justamente o que se corrige.
    reajusteNovo = contrato.fidelidadeNova;
    escreverReajuste = tarefa.dataDeReajuste !== reajusteNovo;
  } else {
    reajusteNovo = fidelidadeRenovada(base);
    // A data da tarefa só é escrita se ainda for a de partida: se já é outra, a
    // chamada repetida (ou a pessoa) já a avançou, e avançar de novo daria +2 anos.
    escreverReajuste = tarefa.dataDeReajuste === null || tarefa.dataDeReajuste === base;
    if (!escreverReajuste) {
      avisos.push(
        `a DATA DE REAJUSTE da tarefa já é ${tarefa.dataDeReajuste}, e não ${base} — já foi avançada, não mexi`,
      );
    } else if (hoje && diasEntre(hoje, base) > DIAS_A_FRENTE_DO_CICLO) {
      escreverReajuste = false;
      avisos.push(
        `a DATA DE REAJUSTE de partida (${formatar(base)}) está mais de ${DIAS_A_FRENTE_DO_CICLO} dias à frente e nenhum contrato a confirma: somar mais um ano pularia uma renovação — não mexi, a equipe confere a data`,
      );
    }
  }

  return {
    aplicavel: true,
    baseDoReajuste: base,
    reajusteNovo,
    escreverReajuste,
    encerramentoNovo,
    escreverEncerramento,
    contrato,
    semContrato,
    avisos,
  };
}

/** A chave da reserva: uma tarefa, uma data de partida. Sombra tem a sua, separada. */
export function chaveDasDatas(tarefaId: string, base: string, sombra = false) {
  return `${sombra ? "datas-sombra" : "datas"}:${tarefaId}:${base}`;
}

function formatar(iso: string) {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

export function comentarioDasDatas(entrada: {
  plano: Extract<PlanoDasDatas, { aplicavel: true }>;
  escreveuReajuste: boolean;
  escreveuEncerramento: boolean;
  fidelidadeNoConexa: "avancada" | "falhou" | "nao-tocada";
  erros: string[];
}) {
  const { plano, escreveuReajuste, escreveuEncerramento, fidelidadeNoConexa, erros } = entrada;
  const linhas = ["📅 **Datas da renovação avançadas pelo sistema** — um ano à frente."];

  if (escreveuReajuste) {
    linhas.push(`- **Data de reajuste:** ${formatar(plano.baseDoReajuste)} → ${formatar(plano.reajusteNovo)}`);
  }
  if (escreveuEncerramento && plano.encerramentoNovo) {
    linhas.push(`- **Data de encerramento:** passou para ${formatar(plano.encerramentoNovo)}`);
  }
  if (fidelidadeNoConexa === "avancada" && plano.contrato) {
    linhas.push(
      `- **Fidelidade no Conexa** (contrato ${plano.contrato.id}): ${formatar(plano.contrato.fidelidadeAtual)} → ${formatar(plano.contrato.fidelidadeNova)}`,
    );
  } else if (fidelidadeNoConexa === "nao-tocada") {
    linhas.push(`- ⚠ **Fidelidade no Conexa não alterada:** ${plano.semContrato ?? "sem contrato ligado a esta tarefa"}`);
  } else if (fidelidadeNoConexa === "falhou") {
    linhas.push("- ⚠ **Fidelidade no Conexa NÃO foi alterada** — veja o erro abaixo e ajuste à mão.");
  }
  for (const aviso of plano.avisos) linhas.push(`- ⚠ ${aviso}`);
  for (const erro of erros) linhas.push(`- ❌ ${erro}`);

  linhas.push("", "_Lançado pelo sistema de agentes, no lugar do fluxo do n8n._");
  return linhas.join("\n");
}
