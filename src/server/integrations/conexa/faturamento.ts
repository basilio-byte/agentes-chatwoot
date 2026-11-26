import { diaEmSaoPaulo, somarDias } from "@/lib/tempo";
import { juntarPaginas, type ConexaClient } from "./client";
import { STATUS_PENDENTE } from "./formatacao";

/**
 * Se uma reserva pode ser cobrada, e como.
 *
 * Nasce da decisão do usuário (15/09/2026) de o agente de Salas de Reunião
 * faturar sozinho a reserva que fecha fora do expediente. Cobrar é a escrita
 * mais cara que um agente faz no ERP, então a decisão de SE cobrar não fica com
 * o modelo: fica aqui, pura e testada, a partir do que o Conexa diz da reserva.
 *
 * Na dúvida, não cobra. Situação fora do vocabulário documentado é recusada e
 * quem segue é a equipe: cobrança errada custa mais que cobrança atrasada.
 */

type Bruto = Record<string, unknown>;

/** `status` da reserva, pela documentação de `GET /room/booking/:id`. */
const JA_FATURADA = new Set(["billed", "paid", "partiallyPaid", "billedNegociated"]);
const CANCELADA = new Set(["cancelled", "billedCancelled"]);

export type SituacaoDeFaturamento =
  | {
      tipo: "faturar";
      vendaId: number;
      clienteId?: number;
      vencimento: string;
      /** O cliente pediu o dia seguinte, mas a reserva é antes disso. */
      diaSeguinteNegado: boolean;
    }
  | { tipo: "pacoteDeHoras" }
  | { tipo: "jaFaturada"; vendaId?: number; clienteId?: number }
  | { tipo: "recusar"; motivo: string };

export type OpcoesDeFaturamento = {
  agora: Date;
  /** Só quando o CLIENTE pediu para pagar no dia seguinte. */
  noDiaSeguinte?: boolean;
};

export function situacaoDeFaturamento(
  reserva: Bruto,
  opcoes: OpcoesDeFaturamento,
): SituacaoDeFaturamento {
  const status = String(reserva.status ?? "");
  const vendaId = typeof reserva.saleId === "number" ? reserva.saleId : undefined;
  const clienteId =
    typeof reserva.customerId === "number" ? reserva.customerId : undefined;

  if (reserva.canceled === true || CANCELADA.has(status)) {
    return { tipo: "recusar", motivo: "A reserva está cancelada: não há o que cobrar." };
  }
  // Cliente com pacote de horas já pagou pelo tempo: cobrar seria cobrar duas
  // vezes a mesma hora.
  if (status === "deductedFromQuota") return { tipo: "pacoteDeHoras" };
  if (reserva.isBilled === true || JA_FATURADA.has(status)) {
    return { tipo: "jaFaturada", vendaId, clienteId };
  }
  if (status !== "notBilled") {
    return {
      tipo: "recusar",
      motivo: `A reserva está na situação "${status || "sem situação"}", que não é uma das documentadas: não dá para cobrar com segurança.`,
    };
  }
  if (!vendaId) {
    return {
      tipo: "recusar",
      motivo: "A reserva não tem venda associada no Conexa: não há o que faturar por aqui.",
    };
  }
  return {
    tipo: "faturar",
    vendaId,
    clienteId,
    ...vencimentoDaCobranca({
      agora: opcoes.agora,
      inicioDaReserva: reserva.startTime,
      noDiaSeguinte: opcoes.noDiaSeguinte,
    }),
  };
}

/**
 * A cobrança vence NO DIA EM QUE É GERADA, no relógio de São Paulo — ou no dia
 * seguinte, se o cliente pedir.
 *
 * Pedido do Diego (task "Melhoria", 24/11/2026): a reserva só fica confirmada com
 * o pagamento. Até então vencia no DIA DA RESERVA (decisão de 15/09, para a
 * reserva de sábado para segunda não nascer vencida no domingo), e a reserva
 * marcada com semanas de antecedência ficava semanas sem pagamento.
 *
 * ⚠ O dia seguinte nunca passa do dia da reserva: pagar depois de usar a sala
 * contradiz "confirmada com o pagamento". Reserva de hoje vence hoje, e quem
 * chama diz isso ao cliente (`diaSeguinteNegado`). Sem o dia da reserva legível,
 * vale hoje — na dúvida, o vencimento mais cedo.
 */
export function vencimentoDaCobranca(args: {
  agora: Date;
  inicioDaReserva: unknown;
  noDiaSeguinte?: boolean;
}): { vencimento: string; diaSeguinteNegado: boolean } {
  const hoje = diaEmSaoPaulo(args.agora);
  if (!args.noDiaSeguinte) return { vencimento: hoje, diaSeguinteNegado: false };
  const amanha = somarDias(hoje, 1);
  const dia = diaDaReserva(args.inicioDaReserva);
  if (!dia || dia < amanha) return { vencimento: hoje, diaSeguinteNegado: true };
  return { vencimento: amanha, diaSeguinteNegado: false };
}

/** O dia em que a reserva começa, no relógio de São Paulo. */
function diaDaReserva(inicio: unknown): string | undefined {
  if (typeof inicio !== "string") return undefined;
  const ms = Date.parse(inicio);
  return Number.isNaN(ms) ? undefined : diaEmSaoPaulo(new Date(ms));
}

/**
 * A cobrança pendente do cliente que já contém esta venda, se houver.
 *
 * É a trava contra cobrar duas vezes: o modelo repete chamada, e nada garante
 * que o Conexa marque a reserva como faturada no mesmo instante em que cria a
 * cobrança. Procura só entre as pendentes, que é onde uma recém-criada está.
 *
 * `conferido: false` quando a lista não veio inteira — aí não dá para afirmar
 * que a cobrança não existe, e quem chama não cobra.
 */
export async function acharCobrancaDaVenda(
  cliente: Pick<ConexaClient, "listarCobrancas">,
  vendaId: number,
  clienteId: number,
): Promise<{ cobranca?: Bruto; conferido: boolean }> {
  const { itens, completo } = await juntarPaginas(
    ({ offset, limit }) =>
      cliente.listarCobrancas({
        customerId: clienteId,
        status: STATUS_PENDENTE,
        limit,
        offset,
      }),
    { porPagina: 50, teto: 200 },
  );
  const cobranca = itens.find(
    (c) => Array.isArray(c.salesIds) && c.salesIds.map(Number).includes(vendaId),
  );
  return { cobranca, conferido: completo };
}
