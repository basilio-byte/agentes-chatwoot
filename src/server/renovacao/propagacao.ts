import { somarDias } from "@/lib/tempo";

import { diferencaMensal, STATUS_NOTIFICACAO, STATUS_PG_PENDENTE, STATUS_RENOVACAO } from "./regras";

/**
 * Fase 2 da renovação: levar para o ClickUp o reajuste que uma PESSOA já
 * aplicou no Conexa.
 *
 * O lote de reajuste é feito na tela do Conexa, num único dia por mês — a API
 * não tem onde escrever índice nem percentual (`lastContractualReadjustment` é
 * só leitura). Depois dele, o ClickUp fica para trás: medido em 10/11/2026 no
 * cliente 5060, dezessete dias depois do lote de 23/10, a tarefa ainda dizia
 * R$ 1.280,00 e o contrato já estava em R$ 1.338,62. Quem fecha essa distância
 * à mão é o Felipe, tarefa por tarefa.
 *
 * Esta é a parte que o sistema faz: LÊ o que o Conexa decidiu e propaga. Nunca
 * reajusta, nunca mexe em data e nunca fala com o cliente.
 *
 * ## O que ela escreve, e o que deixa em paz
 *
 * - **`VALOR CONTRATO`** (currency) — o `amount` de agora, **só se o que está
 *   na tarefa for o valor de ANTES do lote, ou nada**. Qualquer outro valor é
 *   alguém que negociou fora do reajuste, e sobrescrever isso apagaria a
 *   negociação: a rodada deixa como está e escreve o motivo.
 * - **`REAJUSTE`** (number) — o percentual do Conexa. ⚠ Este campo **mente
 *   hoje**: no contrato 3713 a tarefa diz 4,46 e o Conexa, 4,68% em
 *   19/11/2025. É preenchido à mão e deriva, então aqui ele é sobrescrito sem
 *   cerimônia — o número certo é o do ERP.
 * - **O status**, de `notificação renovação` para `pg pendente - renovação`.
 *
 * ⚠⚠ **E o status só avança DESSE status.** Duas automações do ClickUp mandam o
 * e-mail de notificação ao cliente exatamente na transição
 * `renovação` → `notificação renovação`; pular de `renovação` direto para
 * `pg pendente` faria o cliente **nunca ser avisado** do reajuste, sem erro
 * nenhum. Tarefa que o lote pegou ainda em `renovação` fica onde está e espera
 * os dois dias (fase 2b).
 *
 * ⚠ **Não toca em `DATA DE REAJUSTE` nem em `DATA DE ENCERRAMENTO`**: as duas
 * são escritas pela automação `Atualizar datas renovação - N8N` e pela
 * automação 9 do ClickUp, na transição para `ongoing`. Mexer nelas aqui é a
 * fase 3, e exige desligar o n8n no mesmo movimento.
 *
 * ⚠ **E não toca nos checkboxes `REAJUSTE ✅` e `NOTIFICAÇÃO RENOVAÇÃO`.**
 * Ninguém os desmarca entre ciclos: na tarefa 86a1ncr9p os dois estão marcados
 * desde a renovação de 2025 e o reajuste de 2026 ainda não aconteceu. Eles
 * dizem "já passou por aqui alguma vez", não "está feito neste ciclo" — marcar
 * mais um só aumentaria o ruído. Quem guarda o estado deste ciclo é a reserva
 * em `WebhookEvent`.
 */

/** O `VALOR CONTRATO` da Base de clientes (currency). */
export const CAMPO_VALOR_CONTRATO = "0dad1007-feb0-437a-9051-87bbac539d4c";
/** O `REAJUSTE` da Base de clientes (number, em %). */
export const CAMPO_REAJUSTE = "facf3434-9ac9-4276-b81f-fca389a8eeb7";

/** De onde o status pode sair, e para onde vai. */
export const STATUS_ORIGEM = STATUS_NOTIFICACAO;
export const STATUS_DESTINO = STATUS_PG_PENDENTE;

/**
 * Quantos contratos a rodada propaga por vez.
 *
 * ⚠ **O teto existe por causa do token, não do nosso tempo.** O ClickUp limita
 * por minuto e o cliente não tem balde de fichas — só re-tentativa em 429 — e
 * é o MESMO token que os agentes usam para gravar no CRM durante o
 * atendimento. Uma rodada de cem chamadas levaria um turno com cliente do
 * outro lado a esperar o `retry-after`. Dez contratos por rodada são ~50
 * chamadas em alguns segundos; o lote mensal (~80 contratos) escoa em quatro
 * rodadas, e o prazo da renovação é de dias.
 */
export const PROPAGACOES_POR_RODADA = 10;

/** Respiro entre uma tarefa e a seguinte, pelo mesmo motivo do teto. */
export const PAUSA_ENTRE_TAREFAS_MS = 400;

/**
 * Até quantos dias depois do reajuste a rodada ainda propaga.
 *
 * O lote é mensal, então 45 dias cobrem um ciclo com folga. Sem esse recorte,
 * todo reajuste já visto ficaria na fila de candidatos para sempre — e um
 * contrato cuja tarefa nunca entra no fluxo seria reexaminado de meia em meia
 * hora pelo resto do ano.
 */
export const DIAS_PARA_PROPAGAR = 45;

/** O retrato, como a rodada o lê do banco. */
export type RetratoParaPropagar = {
  contratoId: number;
  clienteId: number;
  leva: string;
  /**
   * A fidelidade do contrato (`AAAA-MM-DD`). Serve para casar o contrato com a
   * tarefa dele quando o cliente tem mais de um — ver `casamento.ts`.
   */
  fidelidade?: string | null;
  /** Congelado: o valor da véspera do lote, em centavos. */
  valorCentavos: number;
  /** O valor de agora, em centavos. */
  valorAtualCentavos: number;
  /** O reajuste que o retrato viu quando foi tirado. */
  reajusteDoRetrato: string | null;
  /** O reajuste de agora. */
  reajusteEm: string | null;
  reajustePct: number | null;
  reajusteIndice: string | null;
  periodicidade: string | null;
};

/**
 * O lote de reajuste já passou neste contrato?
 *
 * É o mesmo sinal que `decidirRetrato` usa para congelar: o reajuste de agora
 * não é o que o retrato viu. Sem reajuste nenhum não há o que propagar — e um
 * retrato tirado DEPOIS do lote tem as duas datas iguais, então também não
 * entra (o valor guardado já é o novo, e a tela avisa que é deduzido).
 */
export function loteChegou(retrato: RetratoParaPropagar): boolean {
  return !!retrato.reajusteEm && retrato.reajusteEm !== retrato.reajusteDoRetrato;
}

/** A chave da reserva: um contrato, um reajuste, uma propagação. */
export function chaveDaPropagacao(retrato: RetratoParaPropagar) {
  return `reajuste:${retrato.contratoId}:${retrato.reajusteEm}`;
}

/** O reajuste é recente o bastante para ainda ser propagado? */
export function dentroDaJanela(
  retrato: Pick<RetratoParaPropagar, "reajusteEm">,
  hoje: string,
  dias = DIAS_PARA_PROPAGAR,
) {
  if (!retrato.reajusteEm) return false;
  const corte = somarDias(hoje, -dias);
  return retrato.reajusteEm >= corte;
}

/**
 * A tarefa é mesmo deste cliente?
 *
 * ⚠ O cruzamento da leva com as tarefas é pelo **nome** (`(5060) RAZÃO
 * SOCIAL`), e nome é editável. O `CONEXA LINK` da tarefa traz o `idCliente` na
 * query e serve de segunda testemunha: se ele aponta para OUTRO cliente, a
 * tarefa achada pelo nome não é a desta leva, e escrever nela poria o reajuste
 * de um cliente na ficha de outro.
 *
 * Link ausente ou ilegível **não** barra — a maioria das tarefas antigas não o
 * tem, e exigir o campo pararia a propagação inteira. Barra só a contradição.
 */
export function confereOCliente(clienteId: number, linkDaTarefa?: string | null) {
  const achado = linkDaTarefa?.match(/[?&]idCliente=(\d{1,7})\b/);
  if (!achado) return { confere: true as const };
  const doLink = Number(achado[1]);
  if (doLink === clienteId) return { confere: true as const };
  return {
    confere: false as const,
    motivo: `a tarefa foi achada pelo nome do cliente ${clienteId}, mas o CONEXA LINK dela aponta para o ${doLink}`,
  };
}

export type DecisaoDoValor =
  | { escreve: true; valor: number }
  | { escreve: false; motivo: string };

function centavos(valor: number) {
  return Math.round(valor * 100);
}

/**
 * Escrever o `VALOR CONTRATO`?
 *
 * ⚠ Aqui NÃO vale o "só preenche o vazio" do cadastro completo: o valor na
 * tarefa está preenchido e VELHO, e consertá-lo é o serviço. O que protege o
 * trabalho de uma pessoa é outra régua: só escreve quando o que está lá é
 * reconhecidamente o valor de antes do lote (ou nada). Valor que não é nem o
 * antigo nem o novo é negociação de alguém, e negociação vence reajuste.
 */
export function decidirValor(
  naTarefa: number | null,
  retrato: Pick<RetratoParaPropagar, "valorCentavos" | "valorAtualCentavos">,
): DecisaoDoValor {
  const novo = retrato.valorAtualCentavos / 100;

  if (naTarefa == null) return { escreve: true, valor: novo };

  const atual = centavos(naTarefa);
  if (atual === retrato.valorAtualCentavos) {
    return { escreve: false, motivo: "o valor na tarefa já é o do contrato" };
  }
  if (atual === retrato.valorCentavos) return { escreve: true, valor: novo };

  return {
    escreve: false,
    motivo: `a tarefa está com ${reais(naTarefa)}, que não é o valor de antes (${reais(
      retrato.valorCentavos / 100,
    )}) nem o de agora (${reais(novo)}) — alguém negociou fora do reajuste`,
  };
}

/**
 * Escrever o `REAJUSTE` (%)?
 *
 * Sobrescreve sem olhar o que estava lá, ao contrário do valor: o campo guarda
 * o percentual de um ciclo qualquer, ninguém o zera, e o do ERP é o certo.
 */
export function decidirPercentual(
  naTarefa: number | null,
  retrato: Pick<RetratoParaPropagar, "reajustePct">,
): DecisaoDoValor {
  const pct = retrato.reajustePct;
  if (pct == null) return { escreve: false, motivo: "o Conexa não devolveu o percentual" };
  if (naTarefa != null && Math.abs(naTarefa - pct) < 0.005) {
    return { escreve: false, motivo: "o percentual na tarefa já é o do contrato" };
  }
  return { escreve: true, valor: pct };
}

export type DecisaoDoStatus =
  | { avanca: true; para: string }
  | { avanca: false; motivo: string };

/**
 * Avançar o status?
 *
 * ⚠ Só de `notificação renovação`. Ver o aviso no cabeçalho: de `renovação`, o
 * salto engoliria o e-mail de notificação ao cliente.
 */
export function decidirStatus(status: string | null | undefined): DecisaoDoStatus {
  const atual = (status ?? "").trim().toLowerCase();

  if (atual === STATUS_ORIGEM) return { avanca: true, para: STATUS_DESTINO };
  if (atual === STATUS_DESTINO) {
    return { avanca: false, motivo: `a tarefa já está em "${STATUS_DESTINO}"` };
  }
  if (atual === STATUS_RENOVACAO) {
    return {
      avanca: false,
      motivo: `a tarefa está em "${STATUS_RENOVACAO}" e o cliente ainda não foi notificado — avançar daqui pularia o e-mail de notificação`,
    };
  }
  return {
    avanca: false,
    motivo: atual
      ? `a tarefa está em "${atual}", fora do fluxo de renovação`
      : "não consegui ler o status da tarefa",
  };
}

export function reais(valor: number) {
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dia(iso: string | null) {
  if (!iso) return "—";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

/**
 * O comentário que fica na tarefa.
 *
 * Diz de onde veio o número (índice, percentual e data do ERP), o de→para, e
 * **o que o sistema NÃO fez**. Comentário que só anuncia sucesso faz a pessoa
 * acreditar que o resto foi feito; nomear o que ficou de fora é o que a manda
 * olhar.
 */
export function comentarioDaPropagacao(entrada: {
  retrato: RetratoParaPropagar;
  valor: DecisaoDoValor;
  percentual: DecisaoDoValor;
  status: DecisaoDoStatus;
  linkDoConexa?: string | null;
}) {
  const { retrato, valor, percentual, status, linkDoConexa } = entrada;
  const indice = retrato.reajusteIndice ?? "índice não informado";
  const pct = retrato.reajustePct != null ? `${retrato.reajustePct}%` : "percentual não informado";

  const linhas = [
    `🔁 **Reajuste do contrato lançado no Conexa** — ${indice} ${pct} em ${dia(retrato.reajusteEm)}.`,
    "",
  ];

  const antes = retrato.valorCentavos / 100;
  const agora = retrato.valorAtualCentavos / 100;
  if (valor.escreve) {
    const mensal = diferencaMensal(antes, agora, retrato.periodicidade);
    linhas.push(
      `- **Valor do contrato:** ${reais(antes)} → ${reais(agora)} (${reais(mensal)} por mês)`,
    );
  } else {
    linhas.push(`- ⚠ **Valor do contrato não atualizado:** ${valor.motivo}`);
  }

  if (percentual.escreve) linhas.push(`- **Reajuste:** ${percentual.valor}%`);
  else linhas.push(`- ⚠ **Reajuste (%) não atualizado:** ${percentual.motivo}`);

  if (status.avanca) linhas.push(`- **Status:** ${STATUS_ORIGEM} → ${status.para}`);
  else linhas.push(`- ⚠ **Status não alterado:** ${status.motivo}`);

  if (linkDoConexa) linhas.push("", `Contrato no Conexa: ${linkDoConexa}`);

  linhas.push(
    "",
    "_Lançado pelo sistema de agentes a partir do contrato no Conexa. A data de reajuste e a de encerramento continuam sendo atualizadas pelas automações de sempre._",
  );

  return linhas.join("\n");
}

/** O que a rodada fez com um contrato — o que vai para a reserva e para o MCP. */
export type DesfechoDaPropagacao = {
  contratoId: number;
  clienteId: number;
  tarefaId?: string;
  valorEscrito?: number;
  percentualEscrito?: number;
  statusNovo?: string;
  problemas: string[];
};
