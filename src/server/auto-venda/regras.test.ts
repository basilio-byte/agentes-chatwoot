import { describe, expect, it } from "vitest";
import type { ClickUpCampoPersonalizado, ClickUpTarefa } from "@/server/integrations/clickup/tipos";
import {
  cobrancaDaVenda,
  comentarioDoGanho,
  decidirTarefa,
  desistirDaReserva,
  estadoDaTarefa,
  LISTA_CRM_COMERCIAL,
  lerPagamento,
  opcaoEscolhida,
  reservasDosAgentes,
  situacaoDoPagamento,
  tarefasDasConversas,
  tarefasDaReserva,
  type Chamada,
} from "./regras";

const HORA = 60 * 60_000;
const T0 = new Date("2026-10-14T03:26:00Z");

function chamada(toolName: string, input: unknown, output: unknown, em = T0, conversaId = "c1"): Chamada {
  return { toolName, input, output, createdAt: em, conversaId };
}

const VENDEDOR: ClickUpCampoPersonalizado = {
  id: "vend",
  name: "VENDEDOR",
  type: "drop_down",
  type_config: {
    options: [
      { id: "op-alan", name: "Alan", orderindex: 0 },
      { id: "op-auto", name: "Auto Venda", orderindex: 4 },
    ] as never,
  },
};
const DATA_GANHO: ClickUpCampoPersonalizado = { id: "dg", name: "Data ganho", type: "date" };

describe("reservasDosAgentes", () => {
  it("junta a reserva criada com a cobrança que o agente gerou para ela", () => {
    const reservas = reservasDosAgentes([
      chamada("conexa_criar_reserva", {}, { criada: true, reserva: { id: 29181, inicio: "2026-10-15T09:30:00-03:00" } }),
      chamada("conexa_faturar_reserva", { reservaId: 29181 }, { faturada: true, cobranca: { id: 31735 } }),
    ]);
    expect(reservas).toEqual([
      { reservaId: 29181, conversaId: "c1", criadaEm: T0, inicio: "2026-10-15T09:30:00-03:00", cobrancaId: 31735 },
    ]);
  });

  it("aceita a reserva criada sem leitura de volta (reservaId) e ignora a que não foi criada", () => {
    const reservas = reservasDosAgentes([
      chamada("conexa_criar_reserva", {}, { criada: true, reservaId: 1 }),
      chamada("conexa_criar_reserva", {}, { criada: false, erro: "conflito" }),
      chamada("conexa_faturar_reserva", { reservaId: 1 }, { faturada: false, descontadaDoPacoteDeHoras: true }),
    ]);
    expect(reservas.map((r) => [r.reservaId, r.cobrancaId])).toEqual([[1, null]]);
  });
});

describe("tarefas da reserva", () => {
  const reserva = { reservaId: 1, conversaId: "c1", criadaEm: T0, inicio: null, cobrancaId: null };

  it("vale a criada, a devolvida pela barreira de task em dobro e a passada para Auto Venda", () => {
    const tarefas = tarefasDasConversas([
      chamada("clickup_criar_tarefa", {}, { criada: true, id: "a" }),
      chamada("clickup_criar_tarefa", {}, { criada: false, jaExistia: true, tarefa: { id: "b" } }),
      chamada("clickup_definir_campo_personalizado", { tarefaId: "c", campos: [{ campo: "VENDEDOR", valor: "Auto Venda" }] }, "ok"),
      chamada("clickup_definir_campo_personalizado", { tarefaId: "d", campos: [{ campo: "CELULAR", valor: "+55" }] }, "ok"),
    ]);
    expect(tarefas.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("descarta a task de outra lista quando o retorno diz a lista", () => {
    const tarefas = tarefasDasConversas([
      chamada("clickup_criar_tarefa", {}, { criada: true, id: "atend", listaId: "901306195904" }),
      chamada("clickup_criar_tarefa", {}, { criada: true, id: "crm", listaId: LISTA_CRM_COMERCIAL }),
    ]);
    expect(tarefas.map((t) => t.id)).toEqual(["crm"]);
  });

  it("só a mesma conversa e dentro de um dia, da mais próxima para a mais distante", () => {
    const tarefas = tarefasDasConversas([
      chamada("clickup_criar_tarefa", {}, { criada: true, id: "longe" }, new Date(T0.getTime() - 20 * HORA)),
      chamada("clickup_criar_tarefa", {}, { criada: true, id: "perto" }, new Date(T0.getTime() + 2 * 60_000)),
      chamada("clickup_criar_tarefa", {}, { criada: true, id: "outra-semana" }, new Date(T0.getTime() - 30 * HORA)),
      chamada("clickup_criar_tarefa", {}, { criada: true, id: "outra-conversa" }, T0, "c2"),
    ]);
    expect(tarefasDaReserva(reserva, tarefas)).toEqual(["perto", "longe"]);
  });
});

describe("desistirDaReserva", () => {
  it("conta 45 dias do horário da reserva; sem horário, da criação", () => {
    const comInicio = { reservaId: 1, conversaId: "c", criadaEm: T0, inicio: "2026-10-20T09:00:00-03:00", cobrancaId: null };
    expect(desistirDaReserva(comInicio, new Date("2026-12-03T00:00:00Z"))).toBe(false);
    expect(desistirDaReserva(comInicio, new Date("2026-12-05T00:00:00Z"))).toBe(true);
    expect(desistirDaReserva({ ...comInicio, inicio: null }, new Date("2026-11-29T00:00:00Z"))).toBe(true);
  });
});

describe("situacaoDoPagamento", () => {
  it("só 'paid' é paga; pago em parte espera", () => {
    expect(situacaoDoPagamento({ status: "paid" })).toBe("paga");
    expect(situacaoDoPagamento({ status: "partiallyPaid" })).toBe("esperando");
    expect(situacaoDoPagamento({ status: "billed" })).toBe("esperando");
    expect(situacaoDoPagamento({ status: "notBilled" })).toBe("esperando");
    expect(situacaoDoPagamento({ status: "deductedFromQuota" })).toBe("pacote");
    expect(situacaoDoPagamento({ status: "billedCancelled" })).toBe("cancelada");
    expect(situacaoDoPagamento({ status: "paid", canceled: true })).toBe("cancelada");
    expect(situacaoDoPagamento({ status: "algo novo" })).toBe("esperando");
  });
});

describe("estado e decisão da task", () => {
  function tarefa(parcial: Partial<ClickUpTarefa>): ClickUpTarefa {
    return { id: "t", name: "CW — Fulano", list: { id: LISTA_CRM_COMERCIAL }, ...parcial };
  }

  it("lê o VENDEDOR pelo índice ou pelo id da opção", () => {
    expect(opcaoEscolhida(VENDEDOR, 4)).toBe("Auto Venda");
    expect(opcaoEscolhida(VENDEDOR, "op-auto")).toBe("Auto Venda");
    expect(opcaoEscolhida(VENDEDOR, 0)).toBe("Alan");
    expect(opcaoEscolhida(VENDEDOR, undefined)).toBeNull();
  });

  it("Auto Venda sem ganho no CRM Comercial: dar ganho", () => {
    const estado = estadoDaTarefa(tarefa({ custom_fields: [{ id: "vend", value: 4 }] }), [VENDEDOR, DATA_GANHO]);
    expect(estado).toMatchObject({ autoVenda: true, ganha: false, dataGanhoPreenchida: false });
    expect(decidirTarefa(estado)).toEqual({ acao: "dar ganho" });
  });

  it("já ganha (etiqueta com outra caixa) sai da fila sem escrita", () => {
    const estado = estadoDaTarefa(
      tarefa({ tags: [{ name: " Ganho " }], custom_fields: [{ id: "vend", value: 4 }, { id: "dg", value: "1791000000000" }] }),
      [VENDEDOR, DATA_GANHO],
    );
    expect(estado.dataGanhoPreenchida).toBe(true);
    expect(decidirTarefa(estado).acao).toBe("encerrar");
  });

  it("venda de pessoa espera: a equipe pode ainda corrigir para Auto Venda", () => {
    const estado = estadoDaTarefa(tarefa({ custom_fields: [{ id: "vend", value: 0 }] }), [VENDEDOR]);
    expect(decidirTarefa(estado)).toEqual({ acao: "esperar", motivo: "VENDEDOR não é Auto Venda" });
  });

  it("fora do CRM Comercial ou arquivada não recebe ganho", () => {
    const outraLista = estadoDaTarefa(tarefa({ list: { id: "901306195904" }, custom_fields: [{ id: "vend", value: 4 }] }), [VENDEDOR]);
    expect(decidirTarefa(outraLista).acao).toBe("encerrar");
    const arquivada = estadoDaTarefa(tarefa({ archived: true, custom_fields: [{ id: "vend", value: 4 }] }), [VENDEDOR]);
    expect(decidirTarefa(arquivada).acao).toBe("encerrar");
  });
});

describe("pagamento", () => {
  it("só cobrança paga, com data e valor pago", () => {
    expect(lerPagamento({ chargeId: 31735, status: "paid", paymentDate: "2026-10-15", paidAmount: "140.00" })).toEqual({
      cobrancaId: 31735,
      pagaEm: "2026-10-15",
      valor: 140,
    });
    expect(lerPagamento({ chargeId: 1, status: "unpaid" })).toBeNull();
    expect(lerPagamento({ chargeId: 1, status: "paid", paymentDate: "lixo" })?.pagaEm).toBeNull();
  });

  it("acha a cobrança paga pela venda da reserva", () => {
    const cobrancas = [{ chargeId: 1, salesIds: [10, 11] }, { chargeId: 2, salesIds: ["20"] }];
    expect(cobrancaDaVenda(cobrancas, 20)?.chargeId).toBe(2);
    expect(cobrancaDaVenda(cobrancas, 99)).toBeNull();
  });

  it("o comentário diz reserva, cobrança, valor e data; sem data do Conexa, diz que não veio", () => {
    expect(
      comentarioDoGanho({ reservaId: 29181, pagamento: { cobrancaId: 31735, pagaEm: "2026-10-15", valor: 140 }, dataGanho: "2026-10-15" }),
    ).toBe(
      '🤖 Venda autônoma paga no Conexa: reserva 29181 — cobrança 31735 de R$ 140,00, paga em 15/10/2026. Etiqueta "ganho" aplicada pelo sistema.',
    );
    expect(comentarioDoGanho({ reservaId: 1, pagamento: null, dataGanho: "2026-10-16" })).toContain(
      "vista como paga em 16/10/2026 (a data do pagamento não veio do Conexa)",
    );
  });
});
