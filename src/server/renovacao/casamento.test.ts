import { describe, expect, it } from "vitest";

import {
  LIMITE_DE_CONTRATOS,
  TOLERANCIA_DE_DIAS,
  casarContratosComTarefas,
  pontosDoPar,
  type ContratoParaCasar,
  type TarefaParaCasar,
} from "./casamento";

/**
 * Os casos são os REAIS da Base de clientes em 13/11/2026, quando a Duda
 * corrigiu a regra: cada tarefa é o contrato de UM produto.
 *
 * - `(5051)`: quatro tarefas iguais (R$ 99,90, mesma data) e quatro contratos
 *   iguais no Conexa (R$ 104,48 depois do IPCA de 4,58%).
 * - `(1858)`: duas tarefas de produtos diferentes (EV R$ 89 e sala privativa
 *   R$ 5.800), com datas de reajuste a dois dias uma da outra.
 */

const contrato = (id: number, extra: Partial<ContratoParaCasar> = {}): ContratoParaCasar => ({
  id,
  fidelidade: "2026-11-27",
  antes: 99.9,
  atual: 104.48,
  ...extra,
});

const tarefa = (id: string, extra: Partial<TarefaParaCasar> = {}): TarefaParaCasar => ({
  id,
  valor: 99.9,
  dataDeReajuste: "2026-11-27",
  status: "notificação renovação",
  ...extra,
});

describe("pontosDoPar", () => {
  it("o valor de antes OU o de agora explica a tarefa", () => {
    expect(pontosDoPar(contrato(1), tarefa("a", { dataDeReajuste: null, valor: 99.9 }))).toBe(4);
    expect(pontosDoPar(contrato(1), tarefa("a", { dataDeReajuste: null, valor: 104.48 }))).toBe(4);
  });

  it("a data exata vale mais que a data dentro da tolerância", () => {
    const semValor = { valor: null };
    expect(pontosDoPar(contrato(1), tarefa("a", { ...semValor, dataDeReajuste: "2026-11-27" }))).toBe(2);
    expect(pontosDoPar(contrato(1), tarefa("a", { ...semValor, dataDeReajuste: "2026-11-26" }))).toBe(1);
  });

  it("⚠ data de OUTRO ciclo é incompatível, a menos que o valor explique a tarefa", () => {
    const longe = `2026-12-${String(27 - 20).padStart(2, "0")}`;
    expect(pontosDoPar(contrato(1), tarefa("a", { valor: null, dataDeReajuste: longe }))).toBeNull();
    expect(pontosDoPar(contrato(1), tarefa("a", { valor: 1, dataDeReajuste: longe }))).toBeNull();
    // O valor bate: a data derivou (o n8n soma +364 num fluxo e +365 no outro).
    expect(pontosDoPar(contrato(1), tarefa("a", { valor: 99.9, dataDeReajuste: longe }))).toBe(4);
  });

  it(`a tolerância é de ${TOLERANCIA_DE_DIAS} dias`, () => {
    const t = (d: string) => tarefa("a", { valor: null, dataDeReajuste: d });
    expect(pontosDoPar(contrato(1), t("2026-11-30"))).toBe(1);
    expect(pontosDoPar(contrato(1), t("2026-12-01"))).toBeNull();
  });

  it("sem valor e sem data na tarefa: compatível, mas sem evidência nenhuma", () => {
    expect(pontosDoPar(contrato(1), tarefa("a", { valor: null, dataDeReajuste: null }))).toBe(0);
  });
});

describe("casarContratosComTarefas: o caso comum", () => {
  it("um contrato e uma tarefa casam mesmo sem evidência (tarefa antiga, sem valor nem data)", () => {
    const r = casarContratosComTarefas(
      [contrato(1)],
      [tarefa("a", { valor: null, dataDeReajuste: null })],
    );
    expect(r.pares.map((p) => [p.contrato.id, p.tarefa.id])).toEqual([[1, "a"]]);
    expect(r.semTarefa).toEqual([]);
  });

  it("⚠ mas a única tarefa de OUTRO contrato (data longe, valor diferente) não recebe o reajuste", () => {
    const r = casarContratosComTarefas(
      [contrato(1)],
      [tarefa("a", { valor: 5800, dataDeReajuste: "2026-06-10" })],
    );
    expect(r.pares).toEqual([]);
    expect(r.semTarefa[0].motivo).toContain("outro contrato");
  });

  it("sem tarefa nenhuma, o contrato fica sem tarefa", () => {
    const r = casarContratosComTarefas([contrato(1)], []);
    expect(r.semTarefa[0].motivo).toBe("sem tarefa nos status de renovação");
  });
});

describe("casarContratosComTarefas: vários contratos e várias tarefas", () => {
  it("⚠ (5051) quatro contratos iguais e quatro tarefas iguais: as QUATRO casam, sem ambiguidade", () => {
    const r = casarContratosComTarefas(
      [contrato(10574), contrato(10576), contrato(10578), contrato(10580)],
      [tarefa("t1"), tarefa("t2"), tarefa("t3"), tarefa("t4")],
    );

    expect(r.pares).toHaveLength(4);
    expect(new Set(r.pares.map((p) => p.tarefa.id)).size).toBe(4);
    expect(new Set(r.pares.map((p) => p.contrato.id)).size).toBe(4);
    expect(r.ambiguos).toEqual([]);
    expect(r.semTarefa).toEqual([]);
    expect(r.sobram).toEqual([]);
  });

  it("cinco contratos iguais e quatro tarefas: quatro casam e o quinto SOBRA, sem virar ambiguidade", () => {
    const r = casarContratosComTarefas(
      [contrato(1), contrato(2), contrato(3), contrato(4), contrato(5)],
      [tarefa("t1"), tarefa("t2"), tarefa("t3"), tarefa("t4")],
    );

    expect(r.pares).toHaveLength(4);
    expect(r.ambiguos).toEqual([]);
    expect(r.semTarefa).toHaveLength(1);
    expect(r.semTarefa[0].motivo).toContain("já pertencem a outros contratos");
  });

  it("⚠ (1858) produtos diferentes: o VALOR separa o EV da sala privativa", () => {
    const ev = contrato(10441, { antes: 89, atual: 93.08, fidelidade: "2026-11-06" });
    const sp = contrato(10378, { antes: 5800, atual: 6065.64, fidelidade: "2026-11-04" });
    const r = casarContratosComTarefas(
      // A ordem dos contratos não pode importar.
      [sp, ev],
      [
        tarefa("ev", { valor: 89, dataDeReajuste: "2026-11-06" }),
        tarefa("sp", { valor: 5800, dataDeReajuste: "2026-11-04" }),
      ],
    );

    const mapa = Object.fromEntries(r.pares.map((p) => [p.contrato.id, p.tarefa.id]));
    expect(mapa).toEqual({ 10441: "ev", 10378: "sp" });
    expect(r.ambiguos).toEqual([]);
  });

  it("⚠ o VALOR sozinho já separa dois produtos quando as datas são iguais ou faltam", () => {
    // Tarefa antiga: sem DATA DE REAJUSTE. É só o valor que a liga ao contrato.
    const ev = contrato(1, { antes: 89, atual: 93.08 });
    const sp = contrato(2, { antes: 5800, atual: 6065.64 });
    const r = casarContratosComTarefas(
      [ev, sp],
      [
        tarefa("sp", { valor: 5800, dataDeReajuste: null }),
        tarefa("ev", { valor: 89, dataDeReajuste: null }),
      ],
    );

    expect(Object.fromEntries(r.pares.map((p) => [p.contrato.id, p.tarefa.id]))).toEqual({
      1: "ev",
      2: "sp",
    });
    expect(r.ambiguos).toEqual([]);
  });

  it("a DATA separa contratos de mesmo valor", () => {
    const a = contrato(1, { fidelidade: "2026-12-01" });
    const b = contrato(2, { fidelidade: "2026-12-20" });
    const r = casarContratosComTarefas(
      [a, b],
      [
        tarefa("tarde", { dataDeReajuste: "2026-12-20" }),
        tarefa("cedo", { dataDeReajuste: "2026-12-01" }),
      ],
    );

    expect(Object.fromEntries(r.pares.map((p) => [p.contrato.id, p.tarefa.id]))).toEqual({
      1: "cedo",
      2: "tarde",
    });
  });

  it("valor negociado numa tarefa não impede casar pela data", () => {
    // O valor da tarefa (R$ 120) não é o de antes nem o de agora: alguém negociou.
    const r = casarContratosComTarefas(
      [contrato(1, { fidelidade: "2026-12-01" }), contrato(2, { fidelidade: "2026-12-20" })],
      [
        tarefa("a", { valor: 120, dataDeReajuste: "2026-12-01" }),
        tarefa("b", { valor: 99.9, dataDeReajuste: "2026-12-20" }),
      ],
    );
    expect(Object.fromEntries(r.pares.map((p) => [p.contrato.id, p.tarefa.id]))).toEqual({
      1: "a",
      2: "b",
    });
  });

  it("⚠ UM contrato e DUAS tarefas iguais: não há como saber qual é a dele, e nada casa", () => {
    const r = casarContratosComTarefas([contrato(1)], [tarefa("a"), tarefa("b")]);

    expect(r.pares).toEqual([]);
    expect(r.ambiguos).toHaveLength(1);
    expect(r.ambiguos[0].motivo).toContain("2 tarefas");
    expect(r.ambiguos[0].motivo).toContain("não há como saber");
  });

  it("⚠ dois contratos que o reajuste trata de forma DIFERENTE e duas tarefas iguais: ambiguidade, nada é escrito", () => {
    const r = casarContratosComTarefas(
      [contrato(1, { assinatura: "ipca-4,58" }), contrato(2, { assinatura: "ipca-3,10" })],
      [tarefa("a"), tarefa("b")],
    );

    expect(r.pares).toEqual([]);
    expect(r.ambiguos.map((x) => x.contrato.id).sort()).toEqual([1, 2]);
  });

  it("parte firme, parte ambígua: o que é certo casa e o resto espera", () => {
    // O contrato 1 só tem a tarefa `ev` (valor 89). Os contratos 2 e 3 têm o
    // mesmo valor mas tratamentos diferentes, e as tarefas deles são iguais.
    const r = casarContratosComTarefas(
      [
        contrato(1, { antes: 89, atual: 93.08, assinatura: "ev" }),
        contrato(2, { assinatura: "x" }),
        contrato(3, { assinatura: "y" }),
      ],
      [
        tarefa("ev", { valor: 89 }),
        tarefa("a"),
        tarefa("b"),
      ],
    );

    expect(r.pares.map((p) => [p.contrato.id, p.tarefa.id])).toEqual([[1, "ev"]]);
    expect(r.ambiguos.map((x) => x.contrato.id).sort()).toEqual([2, 3]);
  });

  it("⚠ sem evidência nenhuma, num cliente com vários contratos, NADA casa", () => {
    const r = casarContratosComTarefas(
      [contrato(1), contrato(2)],
      [
        tarefa("a", { valor: null, dataDeReajuste: null }),
        tarefa("b", { valor: null, dataDeReajuste: null }),
      ],
    );

    expect(r.pares).toEqual([]);
    expect(r.semTarefa).toHaveLength(2);
    expect(r.semTarefa[0].motivo).toContain("nenhuma tarefa do cliente");
  });

  it("tarefa de contrato que não está na leva sobra e não atrapalha", () => {
    const r = casarContratosComTarefas(
      [contrato(1)],
      [tarefa("deste"), tarefa("de-outro", { valor: 5800, dataDeReajuste: "2026-06-10" })],
    );

    expect(r.pares.map((p) => p.tarefa.id)).toEqual(["deste"]);
    expect(r.sobram.map((t) => t.id)).toEqual(["de-outro"]);
  });

  it("⚠ cliente com contratos demais não é separado: pede olho humano", () => {
    const muitos = Array.from({ length: LIMITE_DE_CONTRATOS + 1 }, (_, i) => contrato(i + 1));
    const r = casarContratosComTarefas(muitos, [tarefa("a")]);

    expect(r.pares).toEqual([]);
    expect(r.ambiguos).toHaveLength(muitos.length);
    expect(r.ambiguos[0].motivo).toContain("olho humano");
  });
});
