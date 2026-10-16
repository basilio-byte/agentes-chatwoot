import { ETIQUETA_DE_VENDA_GANHA } from "@/server/integrations/clickup/repeticao";
import type {
  ClickUpCampoPersonalizado,
  ClickUpTarefa,
} from "@/server/integrations/clickup/tipos";

/**
 * Venda autônoma paga vira "ganho" no CRM Comercial — as regras, puras.
 *
 * Pedido do Diego (task "Ajustes Auto Venda", 16/10/2026): *"Dar ganho (quando
 * houver pagamento) para as vendas de auto venda"*. A equipe marca o ganho das
 * vendas dela à mão; a venda que o agente fechou sozinho ficava sem ninguém para
 * marcar, e o CRM mostrava menos vendas do que o Conexa.
 *
 * - **A venda é a RESERVA que um agente criou numa conversa** (`conexa_criar_reserva`
 *   com `criada: true`). Nunca procurada por cliente ou telefone: acharia a
 *   reserva que a equipe fez para a mesma pessoa.
 * - **A task é a do CRM Comercial que a mesma conversa criou ou passou para
 *   Auto Venda**, a mais próxima da reserva no tempo, até um dia antes ou depois.
 *   O CRM roda no mesmo turno da reserva; quando o vendedor do rodízio não
 *   respondeu, a task é a dele, criada antes, e o CRM a passa para Auto Venda.
 * - **Pago é o que o Conexa diz da reserva** (`status: paid`). Pago em parte
 *   espera; descontada do pacote de horas e cancelada não têm pagamento e saem
 *   da fila sem ganho.
 * - **Só Auto Venda.** Venda de pessoa da equipe é ela quem marca, com o critério
 *   dela; a regra relê o VENDEDOR a cada rodada, então a task antiga que a equipe
 *   corrigir para Auto Venda entra sozinha.
 * - **O status da task não muda**, como na pesquisa de satisfação: o ganho da
 *   equipe também não muda o status (as ganhas ficam em "aguardando pagamento").
 */

export const PROVIDER_AUTO_VENDA = "AUTO_VENDA";

/** O CRM Comercial (`LISTAS_DO_CRM` tem os dois CRMs; este é o de vendas). */
export const LISTA_CRM_COMERCIAL = "901302419821";
export const CAMPO_VENDEDOR = "VENDEDOR";
export const VENDEDOR_AUTO_VENDA = "Auto Venda";
export const CAMPO_DATA_GANHO = "Data ganho";
export { ETIQUETA_DE_VENDA_GANHA };

/** Ganho não é urgente: de hora em hora, em horário comercial, basta. */
export const CONFERIR_A_CADA_MS = 60 * 60_000;
/** Até onde a rodada olha para trás nas ferramentas usadas. */
export const DIAS_PARA_TRAS = 60;
/** Reserva sem pagamento até tantos dias depois do horário marcado sai da fila. */
export const DIAS_ESPERANDO_PAGAMENTO = 45;
/** A task da reserva está a no máximo isto da reserva, para trás ou para frente. */
export const JANELA_DA_TAREFA_MS = 24 * 60 * 60_000;
/** Teto de reservas olhadas no Conexa por rodada. */
export const RESERVAS_POR_RODADA = 30;

const DIA = 24 * 60 * 60_000;

/** O que a rodada lê de `ToolCall`, já com a conversa da execução. */
export type Chamada = {
  toolName: string;
  input: unknown;
  output: unknown;
  createdAt: Date;
  conversaId: string;
};

export type ReservaDoAgente = {
  reservaId: number;
  conversaId: string;
  criadaEm: Date;
  /** Início da reserva, como o Conexa gravou (ISO). */
  inicio: string | null;
  /** A cobrança que o agente gerou para ela, se gerou. */
  cobrancaId: number | null;
};

export type TarefaDaConversa = { id: string; em: Date; conversaId: string };

/** As reservas que um agente criou, com a cobrança que ele gerou para cada uma. */
export function reservasDosAgentes(chamadas: Chamada[]): ReservaDoAgente[] {
  const cobrancas = new Map<number, number>();
  for (const c of chamadas) {
    if (c.toolName !== "conexa_faturar_reserva") continue;
    const reservaId = inteiro(objeto(c.input).reservaId);
    const saida = objeto(c.output);
    const cobrancaId = inteiro(objeto(saida.cobranca).id) ?? inteiro(saida.cobrancaId);
    if (reservaId && cobrancaId && saida.faturada === true) cobrancas.set(reservaId, cobrancaId);
  }

  const vistas = new Map<number, ReservaDoAgente>();
  for (const c of chamadas) {
    if (c.toolName !== "conexa_criar_reserva") continue;
    const saida = objeto(c.output);
    if (saida.criada !== true) continue;
    const reserva = objeto(saida.reserva);
    const reservaId = inteiro(reserva.id) ?? inteiro(saida.reservaId);
    if (!reservaId || vistas.has(reservaId)) continue;
    vistas.set(reservaId, {
      reservaId,
      conversaId: c.conversaId,
      criadaEm: c.createdAt,
      inicio: typeof reserva.inicio === "string" ? reserva.inicio : null,
      cobrancaId: cobrancas.get(reservaId) ?? null,
    });
  }
  return [...vistas.values()];
}

/**
 * As tasks que cada conversa criou ou passou para Auto Venda: a criada
 * (`criada: true`), a que a barreira de task em dobro devolveu (`jaExistia`) e a
 * que recebeu VENDEDOR Auto Venda pelo CRM (o caminho ATUALIZADA).
 */
export function tarefasDasConversas(chamadas: Chamada[]): TarefaDaConversa[] {
  const tarefas: TarefaDaConversa[] = [];
  for (const c of chamadas) {
    let id: unknown;
    if (c.toolName === "clickup_criar_tarefa") {
      const saida = objeto(c.output);
      // O retorno só traz a lista desde 05/10/2026; sem ela, quem confere é a rodada.
      if (typeof saida.listaId === "string" && saida.listaId !== LISTA_CRM_COMERCIAL) continue;
      if (saida.criada === true) id = saida.id;
      else if (saida.jaExistia === true) id = objeto(saida.tarefa).id;
    } else if (c.toolName === "clickup_definir_campo_personalizado") {
      const entrada = objeto(c.input);
      const campos = Array.isArray(entrada.campos) ? entrada.campos : [];
      const viraAutoVenda = campos.some((campo) => {
        const o = objeto(campo);
        return (
          comparavel(o.campo) === comparavel(CAMPO_VENDEDOR) &&
          comparavel(o.valor) === comparavel(VENDEDOR_AUTO_VENDA)
        );
      });
      if (viraAutoVenda) id = entrada.tarefaId;
    }
    if (typeof id === "string" && id) tarefas.push({ id, em: c.createdAt, conversaId: c.conversaId });
  }
  return tarefas;
}

/**
 * As tasks candidatas da reserva: da mesma conversa, dentro de
 * `JANELA_DA_TAREFA_MS`, da mais próxima no tempo para a mais distante. Fora da
 * janela é outro atendimento — a mesma conversa de WhatsApp dura meses.
 *
 * Lista, e não uma só: a conversa pode ter task no CRM de Atendimentos também,
 * e a criação anterior a 05/10/2026 não gravou a lista. Quem escolhe é a rodada,
 * lendo cada uma até achar a do CRM Comercial.
 */
export function tarefasDaReserva(
  reserva: ReservaDoAgente,
  tarefas: TarefaDaConversa[],
): string[] {
  const perto = new Map<string, number>();
  for (const t of tarefas) {
    if (t.conversaId !== reserva.conversaId) continue;
    const distancia = Math.abs(t.em.getTime() - reserva.criadaEm.getTime());
    if (distancia > JANELA_DA_TAREFA_MS) continue;
    perto.set(t.id, Math.min(distancia, perto.get(t.id) ?? Infinity));
  }
  return [...perto.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

/** A reserva saiu da fila sem pagamento: passou do prazo de espera. */
export function desistirDaReserva(reserva: ReservaDoAgente, agora: Date): boolean {
  const inicio = reserva.inicio ? Date.parse(reserva.inicio) : NaN;
  const base = Number.isNaN(inicio) ? reserva.criadaEm.getTime() : inicio;
  return agora.getTime() > base + DIAS_ESPERANDO_PAGAMENTO * DIA;
}

export type SituacaoDoPagamento = "paga" | "esperando" | "pacote" | "cancelada";

/** Pela `GET /room/booking/:id`. Situação fora do vocabulário espera. */
export function situacaoDoPagamento(reserva: Record<string, unknown>): SituacaoDoPagamento {
  const status = String(reserva.status ?? "");
  if (reserva.canceled === true || status === "cancelled" || status === "billedCancelled") {
    return "cancelada";
  }
  if (status === "deductedFromQuota") return "pacote";
  if (status === "paid") return "paga";
  return "esperando";
}

/** O nome da opção escolhida num campo de lista: a API devolve o índice ou o id. */
export function opcaoEscolhida(
  campo: ClickUpCampoPersonalizado | undefined,
  valor: unknown,
): string | null {
  if (!campo || valor === undefined || valor === null || valor === "") return null;
  const opcoes = (campo.type_config?.options ?? []) as Array<{
    id: string;
    name?: string;
    label?: string;
    orderindex?: number | string;
  }>;
  const achada = opcoes.find(
    (o) => o.id === valor || (o.orderindex !== undefined && String(o.orderindex) === String(valor)),
  );
  return achada?.name ?? achada?.label ?? null;
}

export type EstadoDaTarefa = {
  noCrmComercial: boolean;
  arquivada: boolean;
  ganha: boolean;
  autoVenda: boolean;
  dataGanhoPreenchida: boolean;
};

export function estadoDaTarefa(
  tarefa: ClickUpTarefa,
  campos: ClickUpCampoPersonalizado[],
): EstadoDaTarefa {
  const porNome = (nome: string) =>
    campos.find((c) => comparavel(c.name) === comparavel(nome));
  const valor = (campo: ClickUpCampoPersonalizado | undefined) =>
    campo ? tarefa.custom_fields?.find((v) => v.id === campo.id)?.value : undefined;

  const vendedor = porNome(CAMPO_VENDEDOR);
  const dataGanho = valor(porNome(CAMPO_DATA_GANHO));
  return {
    noCrmComercial: tarefa.list?.id === LISTA_CRM_COMERCIAL,
    arquivada: tarefa.archived === true,
    ganha: (tarefa.tags ?? []).some(
      (t) => comparavel(t.name) === comparavel(ETIQUETA_DE_VENDA_GANHA),
    ),
    autoVenda:
      comparavel(opcaoEscolhida(vendedor, valor(vendedor))) === comparavel(VENDEDOR_AUTO_VENDA),
    dataGanhoPreenchida: dataGanho !== undefined && dataGanho !== null && dataGanho !== "",
  };
}

export type Decisao =
  | { acao: "dar ganho" }
  | { acao: "esperar"; motivo: string }
  | { acao: "encerrar"; motivo: string };

/** Com a reserva paga, o que fazer com a task. */
export function decidirTarefa(estado: EstadoDaTarefa): Decisao {
  if (!estado.noCrmComercial) {
    return { acao: "encerrar", motivo: "a task desta reserva não está no CRM Comercial" };
  }
  if (estado.arquivada) return { acao: "encerrar", motivo: "a task está arquivada" };
  if (estado.ganha) return { acao: "encerrar", motivo: "a task já estava como ganho" };
  // Pode ser task antiga que a equipe ainda vai passar para Auto Venda.
  if (!estado.autoVenda) return { acao: "esperar", motivo: "VENDEDOR não é Auto Venda" };
  return { acao: "dar ganho" };
}

/** O pagamento da reserva, pela cobrança: data (AAAA-MM-DD) e valor pago. */
export type Pagamento = { cobrancaId: number; pagaEm: string | null; valor: number | null };

export function lerPagamento(cobranca: Record<string, unknown>): Pagamento | null {
  const cobrancaId = inteiro(cobranca.chargeId ?? cobranca.id);
  if (!cobrancaId || cobranca.status !== "paid") return null;
  const data = typeof cobranca.paymentDate === "string" ? cobranca.paymentDate.slice(0, 10) : null;
  const valor = Number(cobranca.paidAmount ?? cobranca.amount);
  return {
    cobrancaId,
    pagaEm: data && /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : null,
    valor: Number.isFinite(valor) ? valor : null,
  };
}

/** A cobrança paga que contém a venda da reserva, entre as cobranças pagas do cliente. */
export function cobrancaDaVenda(
  cobrancas: Array<Record<string, unknown>>,
  vendaId: number,
): Record<string, unknown> | null {
  return (
    cobrancas.find(
      (c) => Array.isArray(c.salesIds) && c.salesIds.map(Number).includes(vendaId),
    ) ?? null
  );
}

export function comentarioDoGanho(args: {
  reservaId: number;
  pagamento: Pagamento | null;
  dataGanho: string;
}): string {
  const { pagamento } = args;
  const valor =
    pagamento?.valor !== null && pagamento?.valor !== undefined
      ? ` de ${pagamento.valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`
      : "";
  const cobranca = pagamento ? ` — cobrança ${pagamento.cobrancaId}${valor}` : "";
  const data = pagamento?.pagaEm
    ? `paga em ${dataBr(pagamento.pagaEm)}`
    : `vista como paga em ${dataBr(args.dataGanho)} (a data do pagamento não veio do Conexa)`;
  return (
    `🤖 Venda autônoma paga no Conexa: reserva ${args.reservaId}${cobranca}, ${data}. ` +
    `Etiqueta "${ETIQUETA_DE_VENDA_GANHA}" aplicada pelo sistema.`
  );
}

export function chaveDaReserva(reservaId: number): string {
  return `reserva:${reservaId}`;
}

function dataBr(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

function objeto(valor: unknown): Record<string, unknown> {
  return valor && typeof valor === "object" ? (valor as Record<string, unknown>) : {};
}

function inteiro(valor: unknown): number | null {
  const n = typeof valor === "string" ? Number(valor) : valor;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

function comparavel(valor: unknown): string {
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}
