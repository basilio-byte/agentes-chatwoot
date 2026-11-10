import { describe, expect, it } from "vitest";

import {
  atrasados,
  daLeva,
  deveNotificar,
  diaDeEntrarEmRenovacao,
  diferencaMensal,
  fidelidadeRenovada,
  renovou,
  retratoEhAnterior,
  valorAnterior,
  type ContratoDaLeva,
} from "./regras";

function contrato(over: Partial<ContratoDaLeva> = {}): ContratoDaLeva {
  return {
    id: 1,
    clienteId: 10,
    fidelidade: "2026-12-04",
    valor: 99.9,
    periodicidade: "monthly",
    inicio: "2025-12-05",
    fim: null,
    ativo: true,
    reajusteEm: null,
    reajustePct: null,
    reajusteIndice: null,
    ...over,
  };
}

describe("daLeva", () => {
  it("pega só quem tem fidelidade no mês pedido", () => {
    const leva = daLeva(
      [
        contrato({ id: 1, fidelidade: "2026-12-04" }),
        contrato({ id: 2, fidelidade: "2026-12-31" }),
        contrato({ id: 3, fidelidade: "2027-01-01" }),
        contrato({ id: 4, fidelidade: "2026-11-30" }),
      ],
      "2026-12",
    );
    expect(leva.map((c) => c.id)).toEqual([1, 2]);
  });

  it("contrato encerrado não renova, e sem fidelidade não entra na leva", () => {
    const leva = daLeva(
      [
        contrato({ id: 1, ativo: false }),
        contrato({ id: 2, fidelidade: null }),
        contrato({ id: 3 }),
      ],
      "2026-12",
    );
    expect(leva.map((c) => c.id)).toEqual([3]);
  });
});

describe("atrasados", () => {
  it("é o contrato ATIVO cuja fidelidade já passou", () => {
    const lista = atrasados(
      [
        contrato({ id: 1, fidelidade: "2026-10-31" }),
        contrato({ id: 2, fidelidade: "2026-11-10" }),
        contrato({ id: 3, fidelidade: "2026-09-01", ativo: false }),
      ],
      "2026-11-10",
    );
    expect(lista.map((c) => c.id)).toEqual([1]);
  });
});

describe("diaDeEntrarEmRenovacao", () => {
  it("é 30 dias antes da fidelidade", () => {
    // Medido na produção: a tarefa do contrato que vence em 04/12 foi movida
    // em 04/11.
    expect(diaDeEntrarEmRenovacao("2026-12-04")).toBe("2026-11-04");
  });

  it("atravessa a virada do ano sem erro de mês", () => {
    expect(diaDeEntrarEmRenovacao("2027-01-15")).toBe("2026-12-16");
  });
});

describe("deveNotificar", () => {
  it("só depois de 2 dias no status de renovação", () => {
    expect(deveNotificar("2026-11-04", "2026-11-05")).toBe(false);
    expect(deveNotificar("2026-11-04", "2026-11-06")).toBe(true);
    expect(deveNotificar("2026-11-04", "2026-11-20")).toBe(true);
  });

  it("sem saber quando entrou, não move", () => {
    // A Atividade do ClickUp não é legível pela API: sem o nosso registro, a
    // conta dos 2 dias seria chute.
    expect(deveNotificar(null, "2026-11-20")).toBe(false);
  });
});

describe("fidelidadeRenovada", () => {
  it("anda um ano mantendo o dia", () => {
    expect(fidelidadeRenovada("2026-12-04")).toBe("2027-12-04");
    expect(fidelidadeRenovada("2026-11-30")).toBe("2027-11-30");
  });

  it("⚠ não é +365 nem +364 dias: no bissexto os dois erram", () => {
    // 2027-03-01 menos 365 dias cairia em 2026-03-01 de volta, mas o caminho
    // que importa é o contrário: +365 sobre 2027-03-01 daria 2028-02-29 num
    // ano bissexto. O que a equipe quer é o mesmo dia do ano seguinte.
    expect(fidelidadeRenovada("2027-03-01")).toBe("2028-03-01");
    expect(fidelidadeRenovada("2027-12-31")).toBe("2028-12-31");
  });

  it("29 de fevereiro cai em 28 no ano seguinte", () => {
    expect(fidelidadeRenovada("2028-02-29")).toBe("2029-02-28");
  });
});

describe("retratoEhAnterior", () => {
  const depoisDoLote = contrato({ reajusteEm: "2026-10-23" });

  it("retrato tirado antes do lote vale: o reajuste que ele viu é outro", () => {
    expect(retratoEhAnterior({ valor: 1280, reajusteEm: null }, depoisDoLote)).toBe(true);
    expect(retratoEhAnterior({ valor: 1280, reajusteEm: "2025-11-19" }, depoisDoLote)).toBe(
      true,
    );
  });

  it("⚠ retrato tirado DEPOIS do lote não vale: o valor dele já é o novo", () => {
    expect(retratoEhAnterior({ valor: 1338.62, reajusteEm: "2026-10-23" }, depoisDoLote)).toBe(
      false,
    );
  });

  it("contrato que nunca foi reajustado não tem valor anterior nenhum", () => {
    expect(retratoEhAnterior({ valor: 99.9, reajusteEm: null }, contrato())).toBe(false);
  });
});

describe("valorAnterior", () => {
  // Cliente 5060, conferido nos dois sistemas em 09/11/2026: o Conexa tem
  // 1.338,62 depois do lote de 23/10 (IPCA 4,58%) e o ClickUp ainda tinha
  // 1.280,00.
  const reajustado = contrato({ valor: 1338.62, reajustePct: 4.58, reajusteEm: "2026-10-23" });

  it("o retrato de antes do lote vence, e diz que é retrato", () => {
    expect(valorAnterior(reajustado, { valor: 1280, reajusteEm: "2025-11-19" })).toEqual({
      valor: 1280,
      origem: "retrato",
    });
  });

  it("sem retrato, deduz do percentual do reajuste", () => {
    expect(valorAnterior(reajustado)).toEqual({ valor: 1280, origem: "deduzido" });
  });

  it("⚠ retrato de depois do lote cai para a dedução, em vez de dar diferença zero", () => {
    expect(valorAnterior(reajustado, { valor: 1338.62, reajusteEm: "2026-10-23" })).toEqual({
      valor: 1280,
      origem: "deduzido",
    });
  });

  it("sem reajuste registrado não inventa valor anterior", () => {
    expect(valorAnterior(contrato({ valor: 99.9, reajustePct: null }))).toBeNull();
    expect(valorAnterior(contrato({ valor: null, reajustePct: 4.58 }))).toBeNull();
  });
});

describe("diferencaMensal", () => {
  it("no plano mensal é a diferença direta", () => {
    // Linha real da aba de fevereiro/2026.
    expect(diferencaMensal(104.83, 109.3, "monthly")).toBeCloseTo(4.47, 2);
  });

  it("⚠ no plano anual é dividida por 12 — é assim que a planilha compara", () => {
    // Linha real: 1.308 → 1.363,72, e a planilha mostra 4,6433.
    expect(diferencaMensal(1308, 1363.72, "yearly")).toBeCloseTo(4.6433, 4);
  });

  it("semestral divide por 6", () => {
    expect(diferencaMensal(600, 660, "semester")).toBeCloseTo(10, 4);
  });

  it("periodicidade desconhecida não divide, em vez de chutar", () => {
    expect(diferencaMensal(100, 110, null)).toBeCloseTo(10, 4);
  });
});

describe("renovou", () => {
  it("sair do fluxo para um status de cliente ativo é renovação", () => {
    expect(renovou("notificação renovação", "ongoing")).toBe(true);
    expect(renovou("pg pendente - renovação", "ongoing - sala privativa")).toBe(true);
    expect(renovou("notificação renovação", "seaway")).toBe(true);
    expect(renovou("pg pendente - renovação", "one")).toBe(true);
  });

  it("⚠ sair para distrato NÃO é renovação — não avança a fidelidade de quem sai", () => {
    expect(renovou("pg pendente - renovação", "😢  distrato")).toBe(false);
    expect(renovou("notificação renovação", "negociação")).toBe(false);
    expect(renovou("pg pendente - renovação", "inadimplente")).toBe(false);
    expect(renovou("notificação renovação", "pendencias")).toBe(false);
  });

  it("entrar no fluxo não é renovação: só a SAÍDA conta", () => {
    expect(renovou("ongoing", "renovação")).toBe(false);
    expect(renovou("renovação", "notificação renovação")).toBe(false);
  });

  it("a caixa do status não muda a decisão", () => {
    expect(renovou("NOTIFICAÇÃO RENOVAÇÃO", "ONGOING")).toBe(true);
  });

  it("status ausente não vira renovação por acidente", () => {
    expect(renovou(null, "ongoing")).toBe(false);
    expect(renovou("notificação renovação", undefined)).toBe(false);
  });
});
