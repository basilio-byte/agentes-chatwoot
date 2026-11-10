import { describe, expect, it } from "vitest";

import {
  chaveDaPropagacao,
  comentarioDaPropagacao,
  confereOCliente,
  decidirPercentual,
  decidirStatus,
  decidirValor,
  dentroDaJanela,
  loteChegou,
  reais,
  STATUS_DESTINO,
  STATUS_ORIGEM,
  type RetratoParaPropagar,
} from "./propagacao";

/**
 * ⚠ O dinheiro é comparado pelo MESMO formatador que o código usa. O `Intl`
 * põe um espaço NÃO SEPARÁVEL depois do `R$`, e um literal digitado à mão
 * ("R$ 1.280,00" com espaço comum) nunca casa — foi assim que estes dois
 * testes falharam na primeira execução.
 */

/**
 * O caso real do cliente 5060 (contrato 10601), medido em 10/11/2026: lote de
 * 23/10 aplicou 4,58% de IPCA, o Conexa foi para R$ 1.338,62 e a tarefa do
 * ClickUp continuou em R$ 1.280,00 por dezessete dias.
 */
const RETRATO: RetratoParaPropagar = {
  contratoId: 10601,
  clienteId: 5060,
  leva: "2026-11",
  valorCentavos: 128000,
  valorAtualCentavos: 133862,
  reajusteDoRetrato: null,
  reajusteEm: "2026-10-23",
  reajustePct: 4.58,
  reajusteIndice: "IPCA",
  periodicidade: "Yearly",
};

describe("loteChegou", () => {
  it("o reajuste de agora não é o que o retrato viu: o lote passou", () => {
    expect(loteChegou(RETRATO)).toBe(true);
    expect(loteChegou({ ...RETRATO, reajusteDoRetrato: "2025-11-19" })).toBe(true);
  });

  it("retrato tirado DEPOIS do lote não propaga: o valor guardado já é o novo", () => {
    expect(loteChegou({ ...RETRATO, reajusteDoRetrato: "2026-10-23" })).toBe(false);
  });

  it("contrato sem reajuste nenhum não tem o que propagar", () => {
    expect(loteChegou({ ...RETRATO, reajusteEm: null, reajusteDoRetrato: null })).toBe(false);
  });
});

describe("chaveDaPropagacao", () => {
  it("é um contrato e um reajuste — rodar de novo não escreve de novo", () => {
    expect(chaveDaPropagacao(RETRATO)).toBe("reajuste:10601:2026-10-23");
  });

  it("o reajuste do ano seguinte é outra chave", () => {
    expect(chaveDaPropagacao({ ...RETRATO, reajusteEm: "2027-10-22" })).toBe(
      "reajuste:10601:2027-10-22",
    );
  });
});

describe("dentroDaJanela", () => {
  it("o lote do mês passa; o do ano passado não", () => {
    expect(dentroDaJanela({ reajusteEm: "2026-10-23" }, "2026-11-10")).toBe(true);
    expect(dentroDaJanela({ reajusteEm: "2025-11-19" }, "2026-11-10")).toBe(false);
  });

  it("o corte é inclusivo e os 45 dias cobrem um ciclo com folga", () => {
    expect(dentroDaJanela({ reajusteEm: "2026-09-26" }, "2026-11-10")).toBe(true);
    expect(dentroDaJanela({ reajusteEm: "2026-09-25" }, "2026-11-10")).toBe(false);
  });

  it("sem reajuste não há janela", () => {
    expect(dentroDaJanela({ reajusteEm: null }, "2026-11-10")).toBe(false);
  });
});

describe("confereOCliente", () => {
  it("link do mesmo cliente confere", () => {
    expect(
      confereOCliente(5060, "https://seahubcoworking.conexa.app/index.php?r=x&idCliente=5060"),
    ).toEqual({ confere: true });
  });

  it("⚠ link apontando para OUTRO cliente barra: o reajuste iria para a ficha errada", () => {
    const r = confereOCliente(5060, "https://x.conexa.app/index.php?r=y&idCliente=1858");
    expect(r.confere).toBe(false);
    if (r.confere) throw new Error("deveria barrar");
    expect(r.motivo).toContain("5060");
    expect(r.motivo).toContain("1858");
  });

  it("link ausente ou sem idCliente NÃO barra — tarefa antiga não tem o campo", () => {
    expect(confereOCliente(5060, null).confere).toBe(true);
    expect(confereOCliente(5060, "").confere).toBe(true);
    expect(confereOCliente(5060, "https://x.conexa.app/index.php?r=y").confere).toBe(true);
  });

  it("não casa por prefixo: 185 não é 1858", () => {
    expect(confereOCliente(185, "https://x/?idCliente=1858").confere).toBe(false);
    expect(confereOCliente(1858, "https://x/?idCliente=185").confere).toBe(false);
  });
});

describe("decidirValor", () => {
  it("a tarefa está com o valor de ANTES do lote: escreve o novo", () => {
    expect(decidirValor(1280, RETRATO)).toEqual({ escreve: true, valor: 1338.62 });
  });

  it("campo vazio também é escrito", () => {
    expect(decidirValor(null, RETRATO)).toEqual({ escreve: true, valor: 1338.62 });
  });

  it("já está em dia: não escreve (é o caso do contrato 3713)", () => {
    const decisao = decidirValor(1338.62, RETRATO);
    expect(decisao.escreve).toBe(false);
    expect(decisao).toMatchObject({ motivo: expect.stringContaining("já é o do contrato") });
  });

  it("⚠ valor que não é nem o antigo nem o novo é negociação de alguém: NÃO sobrescreve", () => {
    const decisao = decidirValor(1500, RETRATO);
    expect(decisao.escreve).toBe(false);
    if (decisao.escreve) throw new Error("não deveria escrever");
    // A pessoa precisa ler os três números para decidir, não só "divergente".
    expect(decisao.motivo).toContain(reais(1500));
    expect(decisao.motivo).toContain(reais(1280));
    expect(decisao.motivo).toContain(reais(1338.62));
  });

  it("centavo de diferença por arredondamento não vira divergência", () => {
    expect(decidirValor(1280.004, RETRATO).escreve).toBe(true);
    expect(decidirValor(1338.616, RETRATO).escreve).toBe(false);
  });
});

describe("decidirPercentual", () => {
  it("sobrescreve o percentual velho — o campo deriva e o do ERP é o certo", () => {
    // A tarefa 86a1ncr9p dizia 4,46 com o Conexa em 4,68%.
    expect(decidirPercentual(4.46, { reajustePct: 4.68 })).toEqual({
      escreve: true,
      valor: 4.68,
    });
    expect(decidirPercentual(null, RETRATO)).toEqual({ escreve: true, valor: 4.58 });
  });

  it("igual não é reescrito", () => {
    expect(decidirPercentual(4.58, RETRATO).escreve).toBe(false);
  });

  it("sem percentual no Conexa, não inventa número", () => {
    const decisao = decidirPercentual(4.46, { reajustePct: null });
    expect(decisao.escreve).toBe(false);
  });
});

describe("decidirStatus", () => {
  it("avança de notificação renovação para pg pendente", () => {
    expect(decidirStatus(STATUS_ORIGEM)).toEqual({ avanca: true, para: STATUS_DESTINO });
  });

  it("o ClickUp devolve o status em caixa variada", () => {
    expect(decidirStatus("NOTIFICAÇÃO RENOVAÇÃO").avanca).toBe(true);
    expect(decidirStatus("  notificação renovação ").avanca).toBe(true);
  });

  it("⚠⚠ de `renovação` NÃO avança: o salto engoliria o e-mail ao cliente", () => {
    const decisao = decidirStatus("renovação");
    expect(decisao.avanca).toBe(false);
    if (decisao.avanca) throw new Error("não deveria avançar");
    expect(decisao.motivo).toContain("e-mail de notificação");
  });

  it("já está no destino: nada a fazer", () => {
    expect(decidirStatus(STATUS_DESTINO).avanca).toBe(false);
  });

  it("fora do fluxo (distrato, inativo, ongoing) não é tocado", () => {
    for (const fora of ["😢  distrato", "inativo", "ongoing", "negativado"]) {
      expect(decidirStatus(fora).avanca).toBe(false);
    }
  });

  it("status ilegível não vira avanço", () => {
    expect(decidirStatus(null).avanca).toBe(false);
    expect(decidirStatus("").avanca).toBe(false);
  });
});

describe("comentarioDaPropagacao", () => {
  const completo = comentarioDaPropagacao({
    retrato: RETRATO,
    valor: { escreve: true, valor: 1338.62 },
    percentual: { escreve: true, valor: 4.58 },
    status: { avanca: true, para: STATUS_DESTINO },
    linkDoConexa: "https://seahubcoworking.conexa.app/x?idCliente=5060",
  });

  it("nomeia a fonte: índice, percentual e data do ERP", () => {
    expect(completo).toContain("IPCA 4.58% em 23/10/2026");
  });

  it("mostra o de→para e a diferença MENSAL (anual ÷ 12)", () => {
    expect(completo).toContain(`${reais(1280)} → ${reais(1338.62)}`);
    // (1.338,62 − 1.280) ÷ 12 é 4,885 na conta de cabeça; como `double` a
    // subtração dá 58,61999999999989 e a divisão, 4,884999999999991 — o
    // formatador mostra **4,88**. ⚠ Não se escreve isto como
    // `reais(58.62 / 12)`: aquele caminho chega a 4,885 e mostra 4,89, e o
    // teste passaria a cobrar um número que a tarefa não exibe.
    expect(completo).toContain("R$ 4,88 por mês");
  });

  it("leva o link do contrato, montado pelo sistema", () => {
    expect(completo).toContain("idCliente=5060");
  });

  it("⚠ diz também o que NÃO foi feito, com o motivo", () => {
    const parcial = comentarioDaPropagacao({
      retrato: RETRATO,
      valor: { escreve: false, motivo: "alguém negociou fora do reajuste" },
      percentual: { escreve: true, valor: 4.58 },
      status: { avanca: false, motivo: "a tarefa está em \"renovação\"" },
    });
    expect(parcial).toContain("não atualizado");
    expect(parcial).toContain("alguém negociou fora do reajuste");
    expect(parcial).toContain("Status não alterado");
  });

  it("não promete ter mexido nas datas", () => {
    expect(completo).toContain("continuam sendo atualizadas pelas automações de sempre");
  });
});
