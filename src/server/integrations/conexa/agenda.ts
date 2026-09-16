import { inicioDoDiaEmSaoPaulo } from "@/lib/tempo";

/**
 * Conferência de sobreposição antes de reservar.
 *
 * ⚠ Existe porque **o Conexa não recusa conflito de forma clara** e a tool de
 * criar reserva não conferia nada: o único freio era a instrução de consultar a
 * agenda antes, escrita na descrição da tool e no prompt do agente. Instrução o
 * modelo pode pular — e a reserva autônoma roda de madrugada e no fim de
 * semana, sem ninguém olhando. Duas reservas no mesmo horário são visíveis só
 * quando os dois clientes chegam na porta da sala.
 *
 * Módulo puro: quem fala com a API é a tool.
 */

const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Status em que a reserva deixou de ocupar o horário.
 *
 * Os mesmos dois que a descrição de `conexa_listar_reservas` já promete ao
 * modelo — se divergirem, o agente e o sistema passam a discordar sobre o que é
 * uma sala livre.
 */
const STATUS_QUE_LIBERAM = new Set(["cancelled", "billedcancelled"]);

export type ReservaDaAgenda = {
  id?: number;
  sala?: string;
  inicio?: string;
  fim?: string;
  status?: string;
  cancelada?: unknown;
};

export function ocupaOHorario(reserva: ReservaDaAgenda): boolean {
  if (reserva.cancelada === true) return false;
  const status = (reserva.status ?? "").trim().toLowerCase();
  return !STATUS_QUE_LIBERAM.has(status);
}

/**
 * O instante de `dia` + `HH:MM` no relógio de São Paulo, em milissegundos.
 *
 * Passa pelo `inicioDoDiaEmSaoPaulo` em vez de concatenar `-03:00` na mão: o
 * container roda em UTC, e o deslocamento é responsabilidade de quem conhece o
 * fuso, não de uma string montada aqui.
 */
export function instanteEmSaoPaulo(dia: string, hora: string): number | null {
  const partes = HORA.exec((hora ?? "").trim());
  if (!partes) return null;

  const base = inicioDoDiaEmSaoPaulo(dia).getTime();
  if (!Number.isFinite(base)) return null;

  return base + (Number(partes[1]) * 60 + Number(partes[2])) * 60_000;
}

export type Conferencia =
  | { livre: true }
  | {
      livre: false;
      /** Reservas que pegam o horário pedido. */
      conflitam: ReservaDaAgenda[];
      /** Reservas que ocupam mas cujo horário não deu para ler. */
      ilegiveis: ReservaDaAgenda[];
    };

/**
 * O horário pedido está livre nesta lista de reservas?
 *
 * ⚠ **Encostar não é sobrepor.** 9h-10h e 10h-11h convivem: a comparação é
 * estritamente menor dos dois lados. Tratar o encosto como conflito recusaria
 * metade das reservas legítimas de uma agenda cheia.
 *
 * ⚠ **Reserva que ocupa e cujo horário não dá para ler conta como impedimento.**
 * Não é preciosismo: sem os dois instantes não há como provar que está livre, e
 * entre recusar uma reserva boa e gravar duas no mesmo horário, a primeira se
 * conserta com uma mensagem.
 */
export function conferirHorario(
  reservas: ReservaDaAgenda[],
  pedido: { inicioMs: number; fimMs: number },
): Conferencia {
  const conflitam: ReservaDaAgenda[] = [];
  const ilegiveis: ReservaDaAgenda[] = [];

  for (const reserva of reservas) {
    if (!ocupaOHorario(reserva)) continue;

    const inicio = Date.parse(reserva.inicio ?? "");
    const fim = Date.parse(reserva.fim ?? "");
    if (!Number.isFinite(inicio) || !Number.isFinite(fim)) {
      ilegiveis.push(reserva);
      continue;
    }

    if (inicio < pedido.fimMs && pedido.inicioMs < fim) conflitam.push(reserva);
  }

  if (!conflitam.length && !ilegiveis.length) return { livre: true };
  return { livre: false, conflitam, ilegiveis };
}
