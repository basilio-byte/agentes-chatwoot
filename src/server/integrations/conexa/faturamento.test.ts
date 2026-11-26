import { describe, expect, it } from "vitest";
import { situacaoDeFaturamento as situacaoComRelogio, vencimentoDaCobranca } from "./faturamento";

// Sábado, 19/09/2026, 23h em São Paulo (02h de domingo em UTC): a reserva de
// teste é na segunda, 21/09.
const AGORA = new Date("2026-09-20T02:00:00Z");
const situacaoDeFaturamento = (r: Record<string, unknown>) =>
  situacaoComRelogio(r, { agora: AGORA });

/**
 * SE uma reserva é cobrada. É dinheiro na conta de um cliente, e a decisão não
 * fica com o modelo: cada situação documentada do Conexa tem um caso aqui, e a
 * que não é documentada também.
 */

const reserva = (extra: Record<string, unknown> = {}) => ({
  bookingId: 28400,
  saleId: 190001,
  customerId: 975,
  startTime: "2026-09-21T16:00:00-03:00",
  finalTime: "2026-09-21T17:00:00-03:00",
  isBilled: false,
  canceled: false,
  status: "notBilled",
  ...extra,
});

describe("situacaoDeFaturamento", () => {
  it("reserva não faturada vira cobrança da venda dela, vencendo HOJE", () => {
    // Pedido do Diego (24/11/2026): a reserva se confirma com o pagamento, então
    // a cobrança não espera o dia da reserva (era assim até então).
    expect(situacaoDeFaturamento(reserva())).toEqual({
      tipo: "faturar",
      vendaId: 190001,
      clienteId: 975,
      vencimento: "2026-09-19",
      diaSeguinteNegado: false,
    });
  });

  it("hoje é o dia de São Paulo, não o do UTC", () => {
    // 02h UTC de domingo ainda é sábado em São Paulo.
    expect(situacaoDeFaturamento(reserva())).toMatchObject({ vencimento: "2026-09-19" });
  });

  it("o cliente pede o dia seguinte: vence amanhã", () => {
    expect(
      situacaoComRelogio(reserva(), { agora: AGORA, noDiaSeguinte: true }),
    ).toMatchObject({ tipo: "faturar", vencimento: "2026-09-20", diaSeguinteNegado: false });
  });

  it("pacote de horas não é cobrado", () => {
    expect(situacaoDeFaturamento(reserva({ status: "deductedFromQuota" }))).toEqual({
      tipo: "pacoteDeHoras",
    });
  });

  it("cancelada é recusada, por qualquer um dos sinais", () => {
    for (const sinal of [
      { status: "cancelled" },
      { status: "billedCancelled" },
      { canceled: true },
    ]) {
      expect(situacaoDeFaturamento(reserva(sinal)).tipo).toBe("recusar");
    }
  });

  it("já faturada não gera outra cobrança", () => {
    for (const sinal of [
      { status: "billed" },
      { status: "paid" },
      { status: "partiallyPaid" },
      { isBilled: true },
    ]) {
      expect(situacaoDeFaturamento(reserva(sinal))).toMatchObject({
        tipo: "jaFaturada",
        vendaId: 190001,
      });
    }
  });

  it("situação fora da documentação é recusada — na dúvida, não cobra", () => {
    expect(situacaoDeFaturamento(reserva({ status: "pending" })).tipo).toBe("recusar");
    expect(situacaoDeFaturamento(reserva({ status: undefined })).tipo).toBe("recusar");
  });

  it("sem venda associada é recusada", () => {
    expect(situacaoDeFaturamento(reserva({ saleId: null })).tipo).toBe("recusar");
  });
});

describe("vencimentoDaCobranca", () => {
  const meioDia = new Date("2026-11-26T15:00:00Z"); // 12h de quinta em São Paulo

  it("sem pedido do cliente, vence hoje — mesmo com a reserva semanas depois", () => {
    expect(
      vencimentoDaCobranca({ agora: meioDia, inicioDaReserva: "2026-12-15T09:00:00-03:00" }),
    ).toEqual({ vencimento: "2026-11-26", diaSeguinteNegado: false });
  });

  it("dia seguinte pedido e reserva amanhã ou depois: vence amanhã", () => {
    for (const inicio of ["2026-11-27T08:00:00-03:00", "2026-12-15T09:00:00-03:00"]) {
      expect(
        vencimentoDaCobranca({ agora: meioDia, inicioDaReserva: inicio, noDiaSeguinte: true }),
      ).toEqual({ vencimento: "2026-11-27", diaSeguinteNegado: false });
    }
  });

  it("⚠ reserva HOJE: o dia seguinte é negado, porque pagaria depois de usar a sala", () => {
    expect(
      vencimentoDaCobranca({
        agora: meioDia,
        inicioDaReserva: "2026-11-26T17:00:00-03:00",
        noDiaSeguinte: true,
      }),
    ).toEqual({ vencimento: "2026-11-26", diaSeguinteNegado: true });
  });

  it("sem o dia da reserva legível, na dúvida vence hoje", () => {
    expect(
      vencimentoDaCobranca({ agora: meioDia, inicioDaReserva: undefined, noDiaSeguinte: true }),
    ).toEqual({ vencimento: "2026-11-26", diaSeguinteNegado: true });
  });

  it("perto da meia-noite, hoje é o dia de São Paulo", () => {
    // 23h30 de quinta em São Paulo já é sexta em UTC.
    expect(
      vencimentoDaCobranca({
        agora: new Date("2026-11-27T02:30:00Z"),
        inicioDaReserva: "2026-11-30T09:00:00-03:00",
      }),
    ).toEqual({ vencimento: "2026-11-26", diaSeguinteNegado: false });
  });
});
