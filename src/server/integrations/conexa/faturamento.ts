import { diaEmSaoPaulo } from "@/lib/tempo";
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
  | { tipo: "faturar"; vendaId: number; clienteId?: number; vencimento?: string }
  | { tipo: "pacoteDeHoras" }
  | { tipo: "jaFaturada"; vendaId?: number; clienteId?: number }
  | { tipo: "recusar"; motivo: string };

export function situacaoDeFaturamento(reserva: Bruto): SituacaoDeFaturamento {
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
  return { tipo: "faturar", vendaId, clienteId, vencimento: diaDaReserva(reserva.startTime) };
}

/**
 * O vencimento é o DIA DA RESERVA, no relógio de São Paulo.
 *
 * ⚠ Sem `dueDate`, o Conexa vence a cobrança HOJE. A rota que fatura sozinha é a
 * de fora do expediente: uma reserva feita no sábado para segunda nasceria
 * vencida no domingo, com juros e aviso de atraso antes de o cliente usar a
 * sala.
 */
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
  cliente: ConexaClient,
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
