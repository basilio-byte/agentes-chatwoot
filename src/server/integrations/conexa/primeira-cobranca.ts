/**
 * A primeira cobrança de um contrato — o passo que o Conexa NÃO faz sozinho.
 *
 * ⚠⚠ **O contrato gera a VENDA; a cobrança é outro passo.** Medido na API real
 * em 11/11/2026: o contrato 12946 (cliente 6048, plano 151, mensal, R$ 119)
 * gerou a venda 99001 com `contractId: 12946`, e a cobrança 32953 — a que tem o
 * `chargeUrl` que o cliente abre para pagar — fatura essa venda. Sem esse
 * segundo passo o contrato existe, a venda existe, e **o cliente não tem como
 * pagar**: foi o que aconteceu na primeira contratação real, em que o
 * acompanhamento ficou dizendo "aguardando a cobrança do contrato no Conexa".
 *
 * Quem apontou foi o Diego (11/11/2026): *"para contratos, a gente só precisa
 * gerar manualmente a primeira fatura"*. Eu tinha concluído o contrário por
 * medir que a cobrança EXISTIA no mesmo dia do contrato — o que não prova quem
 * a criou, e se explica igualmente bem por alguém tê-la gerado na hora. A
 * medição acima, do caminho contrato → venda → cobrança, é que separa as duas
 * leituras.
 *
 * É o mesmo desenho de `conexa_faturar_reserva`, e reusa a trava dele: antes de
 * criar, procura entre as cobranças PENDENTES do cliente uma que já fature
 * aquela venda. Cobrar duas vezes é o pior desfecho possível aqui.
 */

import { diaEmSaoPaulo, somarDias } from "@/lib/tempo";
import type { ConexaClient } from "./client";
import type { FiltrosDeCobranca } from "./cobranca-do-contrato";
import { acharCobrancaDaVenda } from "./faturamento";

/**
 * Quantos dias até o vencimento da primeira fatura.
 *
 * ⚠ **Número da equipe, não do código.** Medido nas seis contratações mais
 * recentes do Conexa em 11/11/2026: cinco venceram três dias depois do início
 * do contrato e uma, quatro. Três é o que a equipe pratica — e, por ser dinheiro
 * que vai para o boleto de um cliente, está aqui num lugar só, para mudar numa
 * linha se o Diego ou o Laércio disserem outro.
 */
export const DIAS_ATE_O_VENCIMENTO = 3;

/** O vencimento da primeira fatura, no relógio de São Paulo. */
export function vencimentoDaPrimeiraCobranca(agora: Date): string {
  return somarDias(diaEmSaoPaulo(agora), DIAS_ATE_O_VENCIMENTO);
}

/** Uma venda, no mínimo que este caminho precisa. */
export type VendaResumida = { id: number; contratoId: number | null };

/** A forma crua da listagem de vendas, normalizada. */
export function lerVendas(itens: unknown[]): VendaResumida[] {
  return (itens as Array<Record<string, unknown>>).map((v) => ({
    id: Number(v.saleId ?? v.id) || 0,
    contratoId: Number(v.contractId) || null,
  }));
}

/**
 * A venda daquele contrato, entre as do cliente.
 *
 * ⚠ **A mais ANTIGA**, porque é a primeira do contrato — a que o cliente paga
 * para a contratação começar. Num contrato que já rodou meses há uma venda por
 * ciclo (o 12833 tinha três), e faturar a de outro mês cobraria o período
 * errado.
 */
export function vendaDoContrato(
  vendas: VendaResumida[],
  contratoId: number,
): number | null {
  const daqui = vendas.filter((v) => v.contratoId === contratoId && v.id > 0);
  return daqui.sort((a, b) => a.id - b.id)[0]?.id ?? null;
}

export type ResultadoDaPrimeiraCobranca =
  | { feito: "criada"; cobrancaId: number; faturaUrl: string | null }
  | { feito: "jaExistia"; cobrancaId: number | null; faturaUrl: string | null }
  | { feito: "semVenda" }
  | { feito: "naoConferido"; motivo: string }
  | { feito: "falhou"; motivo: string };

/** O que este caminho precisa do cliente do Conexa. */
export type FaturadorDeContrato = {
  listarVendas: (filtros: {
    customerId?: number;
    limit?: number;
    offset?: number;
  }) => Promise<{ itens: Record<string, unknown>[]; temMais: boolean }>;
  criarCobranca: (dados: {
    salesIds: number[];
    dueDate?: string;
  }) => Promise<{ id: number }>;
  obterCobranca: (id: number) => Promise<Record<string, unknown>>;
  listarCobrancas: (
    filtros: FiltrosDeCobranca,
  ) => Promise<{ itens: Record<string, unknown>[]; temMais: boolean }>;
};

/** Quantas vendas do cliente são olhadas ao procurar a do contrato. */
export const VENDAS_OLHADAS = 50;

/**
 * Gera a primeira cobrança do contrato, se ela ainda não existir.
 *
 * ⚠ **Na dúvida, NÃO cobra** — a mesma doutrina do faturamento de reserva.
 * Lista de cobranças pendentes que não veio inteira devolve `naoConferido`:
 * entre uma cobrança que atrasa e uma cobrança em dobro no cartão de um
 * cliente, a primeira se conserta com uma mensagem.
 *
 * ⚠ **Nunca lança.** Quem chama acabou de criar o contrato; uma exceção aqui
 * faria o agente achar que o contrato falhou e tentar de novo, criando a
 * segunda cobrança recorrente que `duplicidade.ts` existe para evitar.
 */
export async function faturarPrimeiraCobranca(
  cliente: FaturadorDeContrato,
  clienteId: number,
  contratoId: number,
  agora = new Date(),
): Promise<ResultadoDaPrimeiraCobranca> {
  let vendaId: number | null;
  try {
    const { itens } = await cliente.listarVendas({
      customerId: clienteId,
      limit: VENDAS_OLHADAS,
    });
    vendaId = vendaDoContrato(lerVendas(itens), contratoId);
  } catch (erro) {
    return { feito: "falhou", motivo: `não consegui ler as vendas: ${mensagem(erro)}` };
  }

  // ⚠ A venda pode ainda não ter aparecido no instante seguinte à criação do
  // contrato. Não é erro, e não se insiste aqui: a rodada do acompanhamento
  // tenta de novo de dez em dez minutos.
  if (!vendaId) return { feito: "semVenda" };

  let jaTem;
  try {
    jaTem = await acharCobrancaDaVenda(cliente, vendaId, clienteId);
  } catch (erro) {
    return {
      feito: "naoConferido",
      motivo: `não consegui conferir se já existe cobrança desta venda: ${mensagem(erro)}`,
    };
  }
  if (!jaTem.conferido) {
    return {
      feito: "naoConferido",
      motivo:
        "a lista de cobranças pendentes do cliente não veio inteira, então não dá para garantir que ainda não existe uma",
    };
  }
  if (jaTem.cobranca) {
    const id = Number(jaTem.cobranca.chargeId ?? jaTem.cobranca.id) || null;
    return {
      feito: "jaExistia",
      cobrancaId: id,
      faturaUrl: texto(jaTem.cobranca.chargeUrl),
    };
  }

  let cobrancaId: number;
  try {
    ({ id: cobrancaId } = await cliente.criarCobranca({
      salesIds: [vendaId],
      dueDate: vencimentoDaPrimeiraCobranca(agora),
    }));
  } catch (erro) {
    return { feito: "falhou", motivo: `não consegui gerar a cobrança: ${mensagem(erro)}` };
  }

  // O link do cliente só existe depois de a cobrança ser lida de volta.
  try {
    const bruta = await cliente.obterCobranca(cobrancaId);
    return { feito: "criada", cobrancaId, faturaUrl: texto(bruta.chargeUrl) };
  } catch {
    return { feito: "criada", cobrancaId, faturaUrl: null };
  }
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() ? valor : null;
}

function mensagem(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}
