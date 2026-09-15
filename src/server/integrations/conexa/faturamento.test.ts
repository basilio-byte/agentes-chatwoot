import { describe, expect, it } from "vitest";
import { situacaoDeFaturamento } from "./faturamento";

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
  it("reserva não faturada vira cobrança da venda dela", () => {
    expect(situacaoDeFaturamento(reserva())).toEqual({
      tipo: "faturar",
      vendaId: 190001,
      clienteId: 975,
      vencimento: "2026-09-21",
    });
  });

  it("vence no dia da reserva pelo relógio de São Paulo, não pelo UTC", () => {
    // ⚠ Sem vencimento, o Conexa vence HOJE: a reserva de sábado para segunda
    // nasceria vencida.
    const r = situacaoDeFaturamento(reserva({ startTime: "2026-09-22T02:30:00Z" }));
    expect(r).toMatchObject({ tipo: "faturar", vencimento: "2026-09-21" });
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
