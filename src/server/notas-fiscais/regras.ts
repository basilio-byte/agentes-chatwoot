import { somarDias } from "@/lib/tempo";
import { regraDoCliente, type NotasFiscaisConfig } from "./config";

/**
 * Notas fiscais de serviço a partir das cobranças do Conexa — as regras puras.
 *
 * Substitui os dois fluxos de emissão do n8n ("antes" e "após a quitação"),
 * que mandavam TODA nota com o mesmo produto genérico, sem código de serviço.
 * O código certo sai da CATEGORIA DE SERVIÇO que cada produto e cada plano têm
 * no Conexa: cobrança → vendas → produto → categoria → código (tabela da tela).
 *
 * Doutrina: código não é chutado. Item cobrado sem código deixa a cobrança
 * inteira aguardando classificação, e o que precisa de olho humano (retenção de
 * ISS, vendas que não somam a cobrança) vai para conferência.
 */

/** De quanto em quanto tempo o Conexa é conferido. */
export const CONFERIR_A_CADA_MS = 30 * 60_000;

/**
 * Quantos dias para trás a rodada procura cobranças pagas. Também é o teto do
 * início configurado: voltar um mês leria ~850 cobranças de uma vez, e o
 * Conexa limita a 60 requisições por minuto, que os agentes também usam.
 */
export const DIAS_PARA_TRAS = 7;

/** Cobranças novas processadas por rodada; o resto fica para a seguinte. */
export const TETO_POR_RODADA = 40;

/** "quitada": a nota sai no pagamento (o padrão). "gerada": cliente com nota antes. */
export type Evento = "quitada" | "gerada";

const numero = (v: unknown): number | null => {
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const inteiro = (v: unknown): number | null => {
  const n = numero(v);
  return n !== null && Number.isInteger(n) ? n : null;
};
const texto = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
/** `2026-10-05`, de `2026-10-05` ou de `2026-10-05T09:12:00-03:00`. */
const dia = (v: unknown): string | null => {
  const t = texto(v);
  return t && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
};

/** Reais em centavos, sem o erro de ponto flutuante de somar `0.1 + 0.2`. */
export function centavos(valor: number): number {
  return Math.round(valor * 100);
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export function formatarReais(valorCentavos: number): string {
  return BRL.format(valorCentavos / 100);
}

/** O que importa de uma cobrança do Conexa (`GET /charge/:id` ou `/charges`). */
export type CobrancaLida = {
  id: number;
  empresaId: number;
  clienteId: number;
  /** contractual, loose… */
  tipo: string | null;
  /** unpaid, paid, cancelled… */
  status: string | null;
  valorCentavos: number;
  /** Com juros e multa, quando houver. */
  valorAtualCentavos: number | null;
  valorPagoCentavos: number | null;
  quitadaEm: string | null;
  competencia: string | null;
  criadaEm: string | null;
  retemIss: boolean;
  valorIssCentavos: number;
  /** Número da NFS-e que o PRÓPRIO Conexa registra, quando registra. */
  notaNoConexa: number | null;
  vendasIds: number[];
};

export function lerCobranca(bruto: Record<string, unknown>): CobrancaLida | null {
  const id = inteiro(bruto.chargeId ?? bruto.id);
  const empresaId = inteiro(bruto.companyId);
  const clienteId = inteiro(bruto.customerId);
  const valor = numero(bruto.amount);
  if (id === null || empresaId === null || clienteId === null || valor === null) return null;

  const emCentavos = (v: unknown) => {
    const n = numero(v);
    return n === null ? null : centavos(n);
  };
  return {
    id,
    empresaId,
    clienteId,
    tipo: texto(bruto.type),
    status: texto(bruto.status),
    valorCentavos: centavos(valor),
    valorAtualCentavos: emCentavos(bruto.currentAmount),
    valorPagoCentavos: emCentavos(bruto.paidAmount),
    quitadaEm: dia(bruto.paymentDate),
    competencia: dia(bruto.competenceDate),
    criadaEm: dia(bruto.createdAt),
    retemIss: bruto.hasISSRetention === true,
    valorIssCentavos: emCentavos(bruto.ISSAmount) ?? 0,
    notaNoConexa: inteiro(bruto.taxInvoiceNumber),
    vendasIds: Array.isArray(bruto.salesIds)
      ? bruto.salesIds.map(inteiro).filter((n): n is number => n !== null)
      : [],
  };
}

/** Uma venda da cobrança (`GET /sale/:id`). */
export type VendaLida = {
  id: number;
  /** Id do produto — ou da SALA, quando a venda é reserva. */
  produtoId: number | null;
  nome: string;
  quantidade: number;
  valorCentavos: number;
  status: string | null;
  contratoId: number | null;
};

export function lerVenda(bruto: Record<string, unknown>): VendaLida | null {
  const id = inteiro(bruto.saleId ?? bruto.id);
  if (id === null) return null;
  const produto =
    bruto.product && typeof bruto.product === "object"
      ? (bruto.product as Record<string, unknown>)
      : {};
  return {
    id,
    produtoId: inteiro(produto.id ?? bruto.productId),
    nome: texto(produto.name) ?? `venda ${id}`,
    quantidade: inteiro(bruto.quantity) ?? 1,
    valorCentavos: centavos(numero(bruto.amount) ?? 0),
    status: texto(bruto.status),
    contratoId: inteiro(bruto.contractId),
  };
}

/** A categoria de serviço de um produto (`GET /product/:id`). */
export function categoriaDoProduto(bruto: Record<string, unknown>): number | null {
  return inteiro(bruto.categoryId ?? bruto.serviceCategoryId);
}

/**
 * Nome no padrão das salas do Conexa: `[SEAWAY] - SALA DE ATENDIMENTO 02`,
 * `[SEBRAE] - AUDITÓRIO EMPREENDA`. Só vale para item que NÃO existe no
 * cadastro de produtos — é assim que a reserva aparece na venda.
 */
export function ehNomeDeSala(nome: string): boolean {
  return /^\s*\[[^\]]+\]\s*-\s*\S/.test(nome);
}

export type OrigemDoItem = "categoria" | "reserva de sala" | "sem categoria";

export type ItemClassificado = VendaLida & {
  categoriaId: number | null;
  origem: OrigemDoItem;
};

/**
 * De onde o código do item vai sair. `produto` é o que o cadastro devolveu:
 * `null` quando ele respondeu 404.
 */
export function classificarItem(
  venda: VendaLida,
  produto: { categoriaId: number | null } | null,
): ItemClassificado {
  if (produto?.categoriaId != null) {
    return { ...venda, categoriaId: produto.categoriaId, origem: "categoria" };
  }
  if (!produto && ehNomeDeSala(venda.nome)) {
    return { ...venda, categoriaId: null, origem: "reserva de sala" };
  }
  return { ...venda, categoriaId: null, origem: "sem categoria" };
}

/** O código do item pela tabela da tela, ou `null` — nunca um palpite. */
export function codigoDoItem(
  item: Pick<ItemClassificado, "origem" | "categoriaId">,
  config: Pick<NotasFiscaisConfig, "codigos" | "codigoReservaDeSala">,
): string | null {
  if (item.origem === "categoria" && item.categoriaId != null) {
    return config.codigos[String(item.categoriaId)] ?? null;
  }
  if (item.origem === "reserva de sala") return config.codigoReservaDeSala || null;
  return null;
}

function porQueSemCodigo(item: ItemClassificado): string {
  if (item.origem === "categoria") return `"${item.nome}" (categoria ${item.categoriaId} sem código)`;
  if (item.origem === "reserva de sala") return `"${item.nome}" (reserva de sala, sem código configurado)`;
  return `"${item.nome}" (produto ${item.produtoId ?? "?"} sem categoria no Conexa)`;
}

/**
 * A chave da nota: é o `integrationId` que vai à Spedy, idempotente por
 * empresa. A mesma cobrança e o mesmo código dão sempre a mesma chave, e a
 * Spedy não cria segunda nota com ela. Até 36 caracteres.
 */
export function chaveDaNota(cobrancaId: number, codigo: string): string {
  return `conexa-${cobrancaId}-${codigo.replace(/\D/g, "")}`;
}

const TETO_DA_DESCRICAO = 1000;

/** A discriminação do serviço: um item cobrado por linha. */
export function descricaoDaNota(itens: Pick<VendaLida, "nome" | "quantidade">[]): string {
  const texto = itens
    .map((i) => (i.quantidade > 1 ? `${i.quantidade}x ${i.nome}` : i.nome))
    .join("\n");
  return texto.length > TETO_DA_DESCRICAO ? `${texto.slice(0, TETO_DA_DESCRICAO - 1)}…` : texto;
}

export type NotaPlanejada = {
  codigo: string;
  valorCentavos: number;
  descricao: string;
  chave: string;
  vendas: number[];
};

export type Situacao = "PRONTA" | "AGUARDANDO_CLASSIFICACAO" | "CONFERIR" | "FORA_DA_REGRA";

export type Decisao = {
  situacao: Situacao;
  motivo: string | null;
  /** Montadas sempre que todo item cobrado tem código — inclusive em CONFERIR. */
  notas: NotaPlanejada[];
  observacoes: string[];
};

const mesAno = (d: string) => `${d.slice(5, 7)}/${d.slice(0, 4)}`;
const diaMesAno = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** Uma nota por código de serviço: uma NFS-e carrega um código só. */
export function montarNotas(
  cobrancaId: number,
  itens: (ItemClassificado & { codigo: string })[],
): NotaPlanejada[] {
  const porCodigo = new Map<string, (ItemClassificado & { codigo: string })[]>();
  for (const item of itens) {
    const grupo = porCodigo.get(item.codigo) ?? [];
    grupo.push(item);
    porCodigo.set(item.codigo, grupo);
  }
  return [...porCodigo.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([codigo, grupo]) => ({
      codigo,
      valorCentavos: grupo.reduce((s, i) => s + i.valorCentavos, 0),
      descricao: descricaoDaNota(grupo),
      chave: chaveDaNota(cobrancaId, codigo),
      vendas: grupo.map((i) => i.id),
    }));
}

type ConfigDaDecisao = Pick<
  NotasFiscaisConfig,
  "codigos" | "codigoReservaDeSala" | "clientes" | "inicio"
>;

/**
 * As perguntas que NÃO dependem dos itens: regra do cliente, estado da
 * cobrança, valor, nota já registrada. Devolve o motivo de ficar fora, ou
 * `null`. Separada para a rodada não ler as vendas de quem não terá nota.
 */
export function motivoParaFicarFora(
  cobranca: CobrancaLida,
  config: Pick<ConfigDaDecisao, "clientes" | "inicio">,
  evento: Evento,
): string | null {
  const regra = regraDoCliente(config, cobranca.clienteId);
  if (regra === "nunca") return "cliente marcado sem nota automática na tela";
  if (evento === "gerada" && regra !== "antes") {
    return "só cliente marcado \"antes\" tem nota na geração da cobrança";
  }
  // ⚠ Cliente "antes" cuja cobrança só aparece já paga (gerada e paga entre
  // duas rodadas) continua precisando da nota — e ela sai aqui. A exceção é a
  // cobrança gerada ANTES do início: aquela teve a nota na geração pelo fluxo
  // antigo, e emitir de novo no pagamento seria nota em dobro no corte.
  if (
    evento === "quitada" &&
    regra === "antes" &&
    config.inicio &&
    cobranca.criadaEm &&
    cobranca.criadaEm < config.inicio
  ) {
    return "cliente com nota na geração, e a cobrança foi gerada antes do início";
  }

  const statusEsperado = evento === "quitada" ? "paid" : "unpaid";
  if (cobranca.status !== statusEsperado) {
    return `a cobrança está "${cobranca.status ?? "sem status"}"`;
  }
  if (cobranca.valorCentavos <= 0) return "cobrança sem valor";
  if (cobranca.notaNoConexa) {
    return `o próprio Conexa já registra a nota nº ${cobranca.notaNoConexa}`;
  }
  return null;
}

/** A decisão de quem ficou fora antes de os itens serem lidos. */
export function decisaoDeFora(cobranca: CobrancaLida, motivo: string): Decisao {
  return { situacao: "FORA_DA_REGRA", motivo, notas: [], observacoes: observar(cobranca, []) };
}

/**
 * O que fazer com a cobrança. A ordem das perguntas é a da responsabilidade:
 * primeiro a regra do cliente, depois se a cobrança está no estado certo, e só
 * então se dá para montar a nota.
 */
export function decidir(
  cobranca: CobrancaLida,
  itens: ItemClassificado[],
  config: ConfigDaDecisao,
  evento: Evento,
): Decisao {
  const observacoes = observar(cobranca, itens);

  const fora = motivoParaFicarFora(cobranca, config, evento);
  if (fora) return { situacao: "FORA_DA_REGRA", motivo: fora, notas: [], observacoes };

  if (evento === "quitada" && regraDoCliente(config, cobranca.clienteId) === "antes") {
    observacoes.push("cliente com nota na geração, mas a cobrança só foi vista já paga");
  }

  // Item de R$ 0 (reserva descontada do pacote) não vai na nota, e por isso
  // não precisa de código: não pode segurar a cobrança.
  const cobrados = itens.filter((i) => i.valorCentavos > 0);
  if (!cobrados.length) {
    return {
      situacao: "CONFERIR",
      motivo: cobranca.vendasIds.length
        ? "nenhuma venda da cobrança tem valor"
        : "a cobrança veio sem vendas",
      notas: [],
      observacoes,
    };
  }

  const semCodigo = cobrados.filter((i) => codigoDoItem(i, config) === null);
  if (semCodigo.length) {
    return {
      situacao: "AGUARDANDO_CLASSIFICACAO",
      motivo: `sem código de serviço: ${semCodigo.map(porQueSemCodigo).join("; ")}`,
      notas: [],
      observacoes,
    };
  }

  const notas = montarNotas(
    cobranca.id,
    cobrados.map((i) => ({ ...i, codigo: codigoDoItem(i, config)! })),
  );

  const soma = notas.reduce((s, n) => s + n.valorCentavos, 0);
  if (soma !== cobranca.valorCentavos) {
    return {
      situacao: "CONFERIR",
      motivo: `as vendas somam ${formatarReais(soma)} e a cobrança é de ${formatarReais(cobranca.valorCentavos)}`,
      notas,
      observacoes,
    };
  }
  if (cobranca.retemIss) {
    return {
      situacao: "CONFERIR",
      motivo: `o cliente retém ISS (${formatarReais(cobranca.valorIssCentavos)})`,
      notas,
      observacoes,
    };
  }
  return { situacao: "PRONTA", motivo: null, notas, observacoes };
}

/** Avisos que não mudam a decisão, mas que quem confere precisa ver. */
function observar(cobranca: CobrancaLida, itens: ItemClassificado[]): string[] {
  const avisos: string[] = [];
  const pago = cobranca.valorPagoCentavos;
  if (pago !== null && pago !== cobranca.valorCentavos) {
    avisos.push(
      `paga ${formatarReais(pago)} sobre ${formatarReais(cobranca.valorCentavos)} (${pago > cobranca.valorCentavos ? "juros/multa" : "desconto"})`,
    );
  }
  if (
    cobranca.competencia &&
    cobranca.quitadaEm &&
    cobranca.competencia.slice(0, 7) !== cobranca.quitadaEm.slice(0, 7)
  ) {
    avisos.push(
      `competência ${mesAno(cobranca.competencia)}, paga em ${diaMesAno(cobranca.quitadaEm)}`,
    );
  }
  const zerados = itens.filter((i) => i.valorCentavos <= 0).length;
  if (zerados) {
    avisos.push(`${zerados} item(ns) de R$ 0 (descontados do pacote) fora da nota`);
  }
  return avisos;
}

/**
 * De que dia a rodada procura cobranças pagas: o início configurado, mas nunca
 * mais que `DIAS_PARA_TRAS` antes de hoje.
 */
export function desdeQuando(hoje: string, inicio: string | null): string {
  const limite = somarDias(hoje, -DIAS_PARA_TRAS);
  const desde = inicio ?? hoje;
  return desde < limite ? limite : desde > hoje ? hoje : desde;
}
