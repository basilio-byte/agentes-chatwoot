import { STATUS_ONGOING, STATUS_ONGOING_SALA } from "./regras";

/**
 * Fase 4: o cliente pagou o contrato reajustado, a tarefa vai para `ongoing`.
 *
 * Hoje quem faz isso é a equipe, olhando a planilha e o Conexa (passo 4 da Duda:
 * "quitação do cliente … + verifica se é referente ao valor do contrato →
 * ONGOING"). Aqui a conferência é por regra, e o que ela NÃO consegue provar
 * fica para uma pessoa.
 *
 * ⚠⚠ **Mover para `ongoing` não é arrumação.** A passagem faz o ClickUp mandar o
 * e-mail de "cliente renovado" (automação 6), gravar a `DATA DE ENCERRAMENTO`
 * (automação 9) e chamar o webhook de datas (automação 8, hoje o n8n, que
 * empurra a fidelidade no Conexa). Por isso a chave nasce desligada e a regra de
 * "pagou" é a mais cautelosa possível: na dúvida, não fecha.
 */

/** Uma cobrança paga, no mínimo que a regra precisa. */
export type CobrancaPaga = {
  id: number;
  /** `AAAA-MM-DD`. */
  pagaEm: string | null;
  /** O valor efetivamente pago, com juros e multa. */
  valorPago: number | null;
  /** Os ids das vendas faturadas nela. */
  vendas: number[];
};

export type EvidenciaDePagamento = {
  cobrancaId: number;
  pagaEm: string;
  valorPago: number;
};

export type ResultadoDaConferencia =
  | { pagou: true; evidencia: EvidenciaDePagamento }
  | { pagou: false; motivo: string };

function reais(n: number) {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dia(iso: string) {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

/**
 * O cliente já pagou o ciclo NOVO deste contrato?
 *
 * Três coisas ao mesmo tempo, e nenhuma sozinha basta:
 *
 * 1. a cobrança está **paga** e foi paga **depois do reajuste** — pagamento de
 *    antes do lote é do valor antigo;
 * 2. ela **inclui uma venda deste contrato** (cobrança → venda → contrato, o
 *    mesmo caminho das notas fiscais): quem tem dois produtos tem duas cobranças
 *    abertas, e a do outro não prova nada;
 * 3. o **valor pago cobre o valor do contrato de agora** — é a pergunta "é
 *    referente ao valor do contrato?" da Duda. Com juros e multa o cliente paga
 *    mais, e vale; menos, não (desconto na quitação ou pagamento parcial é caso
 *    de uma pessoa).
 *
 * O valor da cobrança que junta várias vendas (o `(5051)` paga os quatro
 * contratos numa fatura só) é a SOMA, então "cobre" ali é o mínimo: pago a menos
 * do que um contrato vale, certamente não pagou o ciclo.
 */
export function pagouOCicloNovo(entrada: {
  reajusteEm: string;
  valorDoContrato: number;
  cobrancas: CobrancaPaga[];
  vendasDoContrato: ReadonlySet<number>;
}): ResultadoDaConferencia {
  const { reajusteEm, valorDoContrato, cobrancas, vendasDoContrato } = entrada;

  const doContrato = cobrancas.filter((c) => c.vendas.some((v) => vendasDoContrato.has(v)));
  if (!doContrato.length) {
    return {
      pagou: false,
      motivo: `nenhuma cobrança paga deste contrato desde o reajuste de ${dia(reajusteEm)}`,
    };
  }

  const depoisDoLote = doContrato.filter((c) => c.pagaEm !== null && c.pagaEm >= reajusteEm);
  if (!depoisDoLote.length) {
    return {
      pagou: false,
      motivo: `as cobranças pagas deste contrato são anteriores ao reajuste de ${dia(reajusteEm)}`,
    };
  }

  // Ordem estável: a mais antiga primeira, porque é a do ciclo.
  const ordenadas = [...depoisDoLote].sort((a, b) => a.id - b.id);
  const cobrindo = ordenadas.find((c) => c.valorPago !== null && c.valorPago >= valorDoContrato - 0.005);
  if (!cobrindo) {
    const maior = Math.max(...ordenadas.map((c) => c.valorPago ?? 0));
    return {
      pagou: false,
      motivo: `a cobrança paga (${reais(maior)}) é menor que o valor do contrato (${reais(valorDoContrato)})`,
    };
  }

  return {
    pagou: true,
    evidencia: {
      cobrancaId: cobrindo.id,
      pagaEm: cobrindo.pagaEm as string,
      valorPago: cobrindo.valorPago as number,
    },
  };
}

/**
 * Para onde vai a tarefa quando o ciclo fecha — `null` quando o sistema não sabe
 * e deixa para a equipe.
 *
 * Sala privativa tem o status dela (`ongoing - sala privativa`). ONE e Seaway
 * renovam para `one` e `seaway`, que são decisão da equipe e não dá para deduzir
 * do pagamento; chutar `ongoing` mandaria o cliente para o fluxo errado.
 */
export function destinoDoCiclo(categoria: string | null | undefined): string | null {
  const c = (categoria ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
  if (c.includes("salas privativas")) return STATUS_ONGOING_SALA;
  if (c === "one") return null;
  return STATUS_ONGOING;
}

/** A forma crua da listagem de cobranças, normalizada para a regra. */
export function lerCobrancasPagas(itens: unknown[]): CobrancaPaga[] {
  const numero = (v: unknown) => {
    const n = Number(v);
    return v !== null && v !== "" && Number.isFinite(n) ? n : null;
  };

  return (itens as Array<Record<string, unknown>>)
    .filter((c) => String(c.status ?? "").trim().toLowerCase() === "paid")
    .map((c) => {
      const id = numero(c.chargeId ?? c.id);
      const pagaEm = typeof c.paymentDate === "string" ? c.paymentDate.slice(0, 10) : null;
      return {
        id: id ?? 0,
        pagaEm: pagaEm && /^\d{4}-\d{2}-\d{2}$/.test(pagaEm) ? pagaEm : null,
        valorPago: numero(c.paidAmount ?? c.amount),
        vendas: Array.isArray(c.salesIds) ? c.salesIds.map(Number).filter(Number.isFinite) : [],
      };
    })
    .filter((c) => c.id > 0);
}

/**
 * A chave da reserva: um contrato, um reajuste, um fechamento. ⚠ O prefixo é
 * `fechamento:`, e não `pagamento:`, que é o do desfecho DIÁRIO da rodada — as
 * duas coisas na mesma família misturariam reserva com resumo na listagem.
 */
export function chaveDoFechamento(contratoId: number, reajusteEm: string) {
  return `fechamento:${contratoId}:${reajusteEm}`;
}

export function comentarioDoFechamento(
  destino: string,
  evidencia: EvidenciaDePagamento,
  valorDoContrato: number,
) {
  return [
    `✅ **Ciclo fechado pelo sistema** — o cliente pagou ${reais(evidencia.valorPago)} em ${dia(evidencia.pagaEm)} (cobrança ${evidencia.cobrancaId}), cobrindo o valor reajustado do contrato (${reais(valorDoContrato)}). Tarefa movida para "${destino}".`,
    "",
    "As automações de sempre rodam a partir daqui: e-mail de cliente renovado, data de encerramento e a atualização de datas.",
    "",
    "_Lançado pelo sistema de agentes a partir do pagamento no Conexa._",
  ].join("\n");
}

export function comentarioDaTrava(destino: string) {
  return [
    `⚠ **O sistema tentou fechar o ciclo e o ClickUp devolveu a tarefa.** O cliente pagou o valor reajustado, mas ao mover para "${destino}" o status não ficou — provavelmente uma trava da lista (por exemplo, o campo "Contrato Assinado" vazio).`,
    "",
    "Confira a tarefa e mova à mão quando estiver certa. O sistema não tenta de novo.",
  ].join("\n");
}
