import { describe, expect, it } from "vitest";
import {
  conferirHorario,
  instanteEmSaoPaulo,
  ocupaOHorario,
  type ReservaDaAgenda,
} from "./agenda";

/** Uma reserva como `formatarReserva` a entrega. */
const reserva = (inicio: string, fim: string, resto: Partial<ReservaDaAgenda> = {}) => ({
  id: 1,
  sala: "[SEAWAY] - SALA DE REUNIÃO 01 - 10 pessoas",
  inicio,
  fim,
  status: "paid",
  ...resto,
});

const PEDIDO = {
  inicioMs: instanteEmSaoPaulo("2026-09-16", "14:00")!,
  fimMs: instanteEmSaoPaulo("2026-09-16", "15:00")!,
};

describe("instante em São Paulo", () => {
  it("monta o horário pelo fuso, não concatenando o deslocamento", () => {
    const meioDia = instanteEmSaoPaulo("2026-09-16", "12:00");
    expect(new Date(meioDia!).toISOString()).toBe("2026-09-16T15:00:00.000Z");
  });

  it("recusa hora malformada em vez de chutar", () => {
    expect(instanteEmSaoPaulo("2026-09-16", "14h")).toBeNull();
    expect(instanteEmSaoPaulo("2026-09-16", "25:00")).toBeNull();
    expect(instanteEmSaoPaulo("2026-09-16", "")).toBeNull();
  });
});

describe("o que ocupa o horário", () => {
  it("cancelada não ocupa — nos dois vocabulários", () => {
    expect(ocupaOHorario(reserva("", "", { status: "cancelled" }))).toBe(false);
    expect(ocupaOHorario(reserva("", "", { status: "billedCancelled" }))).toBe(false);
    expect(ocupaOHorario(reserva("", "", { status: "paid", cancelada: true }))).toBe(false);
  });

  it("o resto ocupa, inclusive pacote de horas e não faturada", () => {
    for (const status of ["paid", "billed", "notBilled", "deductedFromQuota", "partiallyPaid"]) {
      expect(ocupaOHorario(reserva("", "", { status }))).toBe(true);
    }
  });
});

describe("conferir horário", () => {
  it("agenda vazia é livre", () => {
    expect(conferirHorario([], PEDIDO)).toEqual({ livre: true });
  });

  it("⚠ encostar não é sobrepor: 13h-14h e 15h-16h convivem com 14h-15h", () => {
    const vizinhas = [
      reserva("2026-09-16T13:00:00-03:00", "2026-09-16T14:00:00-03:00"),
      reserva("2026-09-16T15:00:00-03:00", "2026-09-16T16:00:00-03:00"),
    ];
    expect(conferirHorario(vizinhas, PEDIDO)).toEqual({ livre: true });
  });

  it("pega sobreposição parcial nas duas pontas", () => {
    const comeca = conferirHorario(
      [reserva("2026-09-16T13:30:00-03:00", "2026-09-16T14:30:00-03:00")],
      PEDIDO,
    );
    const termina = conferirHorario(
      [reserva("2026-09-16T14:30:00-03:00", "2026-09-16T15:30:00-03:00")],
      PEDIDO,
    );
    expect(comeca.livre).toBe(false);
    expect(termina.livre).toBe(false);
  });

  it("pega a reserva que engole o horário pedido", () => {
    const r = conferirHorario(
      [reserva("2026-09-16T08:00:00-03:00", "2026-09-16T18:00:00-03:00")],
      PEDIDO,
    );
    expect(r.livre).toBe(false);
    expect(r.livre === false && r.conflitam).toHaveLength(1);
  });

  it("reserva cancelada no mesmo horário não impede", () => {
    const r = conferirHorario(
      [reserva("2026-09-16T14:00:00-03:00", "2026-09-16T15:00:00-03:00", { status: "cancelled" })],
      PEDIDO,
    );
    expect(r).toEqual({ livre: true });
  });

  it("⚠ reserva que ocupa e não dá para ler o horário impede, e é contada à parte", () => {
    // Sem os dois instantes não há como provar que está livre. Recusar se
    // conserta com uma mensagem; reservar em cima, não.
    const r = conferirHorario([reserva("", "", { status: "paid", id: 77 })], PEDIDO);
    expect(r.livre).toBe(false);
    expect(r.livre === false && r.ilegiveis.map((x) => x.id)).toEqual([77]);
    expect(r.livre === false && r.conflitam).toEqual([]);
  });

  it("horário ilegível de reserva CANCELADA não impede", () => {
    const r = conferirHorario([reserva("", "", { status: "cancelled" })], PEDIDO);
    expect(r).toEqual({ livre: true });
  });
});
