/**
 * Achata as respostas do Conexa para o que o agente precisa ler.
 *
 * Puro e testado: a API devolve dezenas de campos por objeto (`GET /charge/:id`
 * sozinho tem 40), e mandar tudo para o modelo gasta token à toa e ainda deixa
 * dado de cliente circulando sem necessidade.
 */

type Bruto = Record<string, unknown>;

const texto = (v: unknown) => (v == null ? undefined : String(v));
const numero = (v: unknown) => (typeof v === "number" ? v : undefined);

/**
 * Cobrança pendente no Conexa é **`unpaid`** — não `open`.
 *
 * O vocabulário completo é `unpaid`, `paid`, `negotiated`,
 * `generatedByNegotiation`, `cancelled`, `denied`, `thirdPartyCompany`,
 * `protested`, `juridical` e `excluded`. Filtrar por "open", que é o nome usado
 * em outros sistemas, devolve lista vazia sempre — e o agente diria a um
 * cliente inadimplente que ele não deve nada.
 */
export const STATUS_PENDENTE = "unpaid";

export function ehCobrancaPendente(status: unknown) {
  return String(status ?? "").toLowerCase() === STATUS_PENDENTE;
}

export function formatarCliente(bruto: Bruto) {
  return {
    id: numero(bruto.customerId ?? bruto.id),
    nome: texto(bruto.name ?? bruto.tradeName),
    razaoSocial: texto(bruto.legalName),
    cpf: texto(bruto.cpf),
    cnpj: texto(bruto.cnpj),
    email: texto(bruto.email),
    telefone: texto(bruto.phone ?? bruto.cellphone),
    ativo: bruto.isActive ?? bruto.active,
    unidade: numero(bruto.companyId),
  };
}

export function formatarPlano(bruto: Bruto) {
  return {
    id: numero(bruto.planId ?? bruto.id),
    nome: texto(bruto.name),
    valor: numero(bruto.amount ?? bruto.price),
    ativo: bruto.isActive,
    unidade: numero(bruto.companyId),
  };
}

/**
 * Cobrança com o que o cliente precisa para pagar.
 *
 * `currentAmount` vem antes de `amount` de propósito: é o valor **com juros e
 * multa**. Mandar o valor original para quem está atrasado é prometer um preço
 * que o boleto não vai cobrar.
 */
export function formatarCobranca(bruto: Bruto) {
  return {
    id: numero(bruto.chargeId ?? bruto.id),
    status: texto(bruto.status),
    pendente: ehCobrancaPendente(bruto.status),
    valorAtual: numero(bruto.currentAmount) ?? numero(bruto.amount),
    valorOriginal: numero(bruto.amount),
    vencimento: texto(bruto.dueDate),
    linhaDigitavel: texto(bruto.billetDigitableLine),
    boletoUrl: texto(bruto.billetUrl),
    faturaUrl: texto(bruto.chargeUrl),
    notaFiscal: numero(bruto.taxInvoiceNumber),
  };
}

export function formatarContrato(bruto: Bruto) {
  return {
    id: numero(bruto.contractId ?? bruto.id),
    cliente: numero(bruto.customerId),
    plano: numero(bruto.planId),
    inicio: texto(bruto.startDate),
    fim: texto(bruto.endDate),
    periodicidade: texto(bruto.paymentFrequency),
    valor: numero(bruto.amount),
    ativo: bruto.isActive,
  };
}

export function formatarReserva(bruto: Bruto) {
  const sala = (bruto.place ?? {}) as Bruto;
  return {
    id: numero(bruto.bookingId ?? bruto.id),
    sala: texto(sala.name),
    salaId: numero(sala.id),
    cliente: numero(bruto.customerId),
    inicio: texto(bruto.startTime),
    fim: texto(bruto.finalTime),
    status: texto(bruto.status),
    cancelada: bruto.canceled,
    observacoes: texto(bruto.notes),
  };
}

/** Tira do objeto as chaves que ficaram sem valor, para não gastar token. */
export function semVazios<T extends Record<string, unknown>>(obj: T) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );
}
