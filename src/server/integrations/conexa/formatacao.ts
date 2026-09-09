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

/**
 * Teto do campo de observações do cliente.
 *
 * ⚠ **Não é limite documentado do Conexa** — a documentação da API não declara
 * nenhum, e inventar um número como se fosse dela seria pior que não ter. O
 * teto existe por outro motivo, que vale sozinho: `notes` é UM campo de texto
 * que uma pessoa lê na tela do ERP, e um campo com dezenas de milhares de
 * caracteres já não é legível. Acrescentar para sempre transforma a anotação
 * útil de hoje em lixo amanhã.
 *
 * Estourou, a tool RECUSA e manda uma pessoa limpar. Cortar seria destruir
 * justamente o texto humano que este caminho existe para preservar.
 */
export const TETO_DE_OBSERVACOES = 20_000;

/**
 * De onde saiu a anotação, na palavra que uma pessoa do comercial vai ler.
 *
 * ⚠ **Carimbo com origem errada é pior que carimbo nenhum.** A string literal
 * `· atendimento` foi escrita quando o único caminho era o Chatwoot; a mesa do
 * agente não tem conversa nenhuma, e uma anotação carimbada como atendimento
 * manda quem cobra ou renova procurar uma conversa que não existe em
 * /conversas — ou ele desconfia da linha inteira, ou acredita nela sem poder
 * conferir. E `notes` não tem desfazer.
 *
 * ⚠ **A palavra do lado "sem conversa" tem de ser verdadeira em TODAS as
 * origens sem conversa, não só na mesa.** Gatilho HTTP e agendamento também
 * chamam esta tool, e o `ToolContext` só sabe dizer se há conversa do Chatwoot
 * — não qual das outras origens é. Escrever "mesa" ali seria repetir, em três
 * origens, exatamente a mentira que esta função existe para tirar.
 *
 * "robô" é a palavra que o projeto já usa para separar a nossa máquina de uma
 * pessoa, e é a única coisa que o carimbo precisa garantir: que aquela linha,
 * no meio de texto escrito à mão, não foi um colega quem afirmou. Quem lê o
 * ERP não conhece a mesa, o gatilho nem o agendamento — e não precisa.
 */
export function carimboDaAnotacao(
  quando: { data: string; hora: string },
  origem: { chatwootConversationId?: number | null },
): string {
  const de = origem.chatwootConversationId != null ? "atendimento" : "robô";
  return `${quando.data} ${quando.hora} · ${de}`;
}

/**
 * Acrescenta uma anotação ao campo de observações, preservando o que já existe.
 *
 * ⚠ **Preservar não é detalhe, é a razão desta função existir.** `notes` do
 * Conexa é um campo único: gravar nele SUBSTITUI. A equipe comercial escreve
 * ali à mão, e um `PATCH` ingênuo apagaria tudo sem erro nenhum e sem desfazer
 * — a mesma armadilha dos `custom_attributes` e dos labels do Chatwoot, que
 * neste projeto já mordeu duas vezes. Ler, mesclar, escrever.
 *
 * O carimbo entra porque quem lê o ERP precisa saber que aquilo saiu de um
 * robô e quando: anotação sem origem, no meio de texto escrito por gente, é
 * indistinguível de alguém da equipe tendo afirmado aquilo.
 *
 * Pura e testada de propósito — é aqui que texto de cliente se perde.
 */
export function acrescentarAnotacao(
  atual: unknown,
  anotacao: string,
  carimbo: string,
): { texto: string; excedeu: boolean; tamanho: number } {
  const anterior = (atual == null ? "" : String(atual)).trimEnd();
  const linha = `[${carimbo}] ${anotacao.trim()}`;

  // Sem conteúdo anterior, nada de linha em branco no começo do campo.
  const texto = anterior ? `${anterior}\n${linha}` : linha;

  return {
    texto,
    excedeu: texto.length > TETO_DE_OBSERVACOES,
    tamanho: texto.length,
  };
}
