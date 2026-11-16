import { describe, expect, it } from "vitest";

import {
  chaveDasDatas,
  comentarioDasDatas,
  lerDataDoClickUp,
  lerPedidoDasDatas,
  planejarDatas,
  statusDeContinuidade,
  type ContratoParaDatas,
  type TarefaParaDatas,
} from "./datas";

describe("lerDataDoClickUp", () => {
  it("lê o formato que o n8n esperava: MMM DD YYYY", () => {
    expect(lerDataDoClickUp("Dec 04 2026")).toBe("2026-12-04");
    expect(lerDataDoClickUp("Sep 24 2025")).toBe("2025-09-24");
    expect(lerDataDoClickUp("Dec 4, 2026")).toBe("2026-12-04");
  });

  it("aceita o mês em português, caso a automação esteja no idioma do usuário", () => {
    expect(lerDataDoClickUp("dez 04 2026")).toBe("2026-12-04");
    expect(lerDataDoClickUp("Set 09 2026")).toBe("2026-09-09");
  });

  it("aceita ISO, dd/mm/aaaa e milissegundos (o formato do próprio campo)", () => {
    expect(lerDataDoClickUp("2026-12-04")).toBe("2026-12-04");
    expect(lerDataDoClickUp("04/12/2026")).toBe("2026-12-04");
    // 27/11/2026, quatro da manhã em São Paulo.
    expect(lerDataDoClickUp("1795762800000")).toBe("2026-11-27");
  });

  it("⚠ data que não é entendida ou não existe vira nulo — nunca chute", () => {
    expect(lerDataDoClickUp("")).toBeNull();
    expect(lerDataDoClickUp(null)).toBeNull();
    expect(lerDataDoClickUp("Foo 04 2026")).toBeNull();
    expect(lerDataDoClickUp("Feb 30 2026")).toBeNull();
    expect(lerDataDoClickUp("31/02/2026")).toBeNull();
    expect(lerDataDoClickUp("amanhã")).toBeNull();
  });
});

describe("lerPedidoDasDatas", () => {
  it("lê os nomes que a automação do n8n usa", () => {
    const p = lerPedidoDasDatas(
      { taskid: "86adjmaqg", datadereajuste: "Nov 27 2026", dataencerramento: "Nov 27 2026" },
      null,
    );
    expect(p).toEqual({
      tarefaId: "86adjmaqg",
      dataReajuste: "2026-11-27",
      dataEncerramento: "2026-11-27",
    });
  });

  it("cai para o corpo quando o query não traz, inclusive aninhado em `payload`", () => {
    expect(lerPedidoDasDatas({}, { task_id: "abc123" }).tarefaId).toBe("abc123");
    expect(lerPedidoDasDatas({}, { payload: { id: "abc123" } }).tarefaId).toBe("abc123");
  });

  it("⚠ só o id é indispensável, e id com formato estranho é recusado", () => {
    expect(lerPedidoDasDatas({ taskid: "86adjmaqg" }, null).dataReajuste).toBeNull();
    expect(lerPedidoDasDatas({ taskid: "../../etc" }, null).tarefaId).toBeNull();
    expect(lerPedidoDasDatas({ taskid: "a" }, null).tarefaId).toBeNull();
    expect(lerPedidoDasDatas({}, null).tarefaId).toBeNull();
  });
});

const tarefa = (extra: Partial<TarefaParaDatas> = {}): TarefaParaDatas => ({
  id: "86adjmaqg",
  status: "ongoing",
  valor: 104.48,
  dataDeReajuste: "2026-11-27",
  dataDeEncerramento: "2026-11-27",
  ...extra,
});

const contrato = (id: number, extra: Partial<ContratoParaDatas> = {}): ContratoParaDatas => ({
  id,
  fidelidade: "2026-11-27",
  valor: 104.48,
  antes: 99.9,
  ativo: true,
  ...extra,
});

const aplicavel = (p: ReturnType<typeof planejarDatas>) => {
  if (!p.aplicavel) throw new Error(`não aplicável: ${p.motivo}`);
  return p;
};

describe("planejarDatas", () => {
  it("o caso comum: um contrato, uma tarefa — tudo avança um ANO", () => {
    const p = aplicavel(
      planejarDatas({
        tarefa: tarefa(),
        pedido: { tarefaId: "x", dataReajuste: "2026-11-27", dataEncerramento: "2026-11-27" },
        contratos: [contrato(10574)],
      }),
    );
    expect(p.reajusteNovo).toBe("2027-11-27");
    expect(p.escreverReajuste).toBe(true);
    expect(p.encerramentoNovo).toBe("2027-11-27");
    expect(p.contrato).toEqual({
      id: 10574,
      fidelidadeAtual: "2026-11-27",
      fidelidadeNova: "2027-11-27",
    });
    expect(p.semContrato).toBeNull();
  });

  it("⚠ é +1 ano de calendário, não +365 dias: 29/02 cai em 28/02", () => {
    const p = aplicavel(
      planejarDatas({
        tarefa: tarefa({ dataDeReajuste: "2028-02-29" }),
        pedido: { tarefaId: "x", dataReajuste: "2028-02-29", dataEncerramento: null },
        contratos: [],
      }),
    );
    expect(p.reajusteNovo).toBe("2029-02-28");
  });

  it("⚠ só avança quando o cliente CONTINUA: distrato, negociação e companhia não mexem em data", () => {
    for (const status of ["😢 distrato", "negociação", "inadimplente", "pg pendente - renovação"]) {
      const p = planejarDatas({
        tarefa: tarefa({ status }),
        pedido: { tarefaId: "x", dataReajuste: "2026-11-27", dataEncerramento: null },
        contratos: [contrato(1)],
      });
      expect(p.aplicavel).toBe(false);
    }
    for (const status of ["ongoing", "ongoing - sala privativa", "seaway", "one"]) {
      expect(statusDeContinuidade(status)).toBe(true);
    }
  });

  it("sem data de reajuste (na URL nem na tarefa) não há de onde avançar", () => {
    const p = planejarDatas({
      tarefa: tarefa({ dataDeReajuste: null }),
      pedido: { tarefaId: "x", dataReajuste: null, dataEncerramento: null },
      contratos: [contrato(1)],
    });
    expect(p).toMatchObject({ aplicavel: false });
  });

  it("a data da URL vale como ponto de partida mesmo que a tarefa já mostre outra coisa", () => {
    // A automação 9 do ClickUp já regravou a ENCERRAMENTO; a REAJUSTE da tarefa é a de partida.
    const p = aplicavel(
      planejarDatas({
        tarefa: tarefa({ dataDeEncerramento: "2027-11-16" }),
        pedido: { tarefaId: "x", dataReajuste: "2026-11-27", dataEncerramento: "2026-11-27" },
        contratos: [contrato(1)],
      }),
    );
    // Valor antigo + 1 ano (o comportamento do n8n), por cima do "hoje + 365" da automação 9.
    expect(p.encerramentoNovo).toBe("2027-11-27");
    expect(p.escreverEncerramento).toBe(true);
  });

  it("⚠ data de reajuste da tarefa que JÁ foi avançada não é avançada de novo (+2 anos)", () => {
    const p = aplicavel(
      planejarDatas({
        tarefa: tarefa({ dataDeReajuste: "2027-11-27" }),
        pedido: { tarefaId: "x", dataReajuste: "2026-11-27", dataEncerramento: null },
        contratos: [],
      }),
    );
    expect(p.escreverReajuste).toBe(false);
    expect(p.avisos.join(" ")).toContain("já foi avançada");
  });

  it("sem a DATA DE ENCERRAMENTO na URL, deixa a que a automação do ClickUp gravou", () => {
    const p = aplicavel(
      planejarDatas({
        tarefa: tarefa(),
        pedido: { tarefaId: "x", dataReajuste: "2026-11-27", dataEncerramento: null },
        contratos: [contrato(1)],
      }),
    );
    expect(p.escreverEncerramento).toBe(false);
    expect(p.avisos.join(" ")).toContain("DATA DE ENCERRAMENTO");
  });

  it("⚠ (5051) quatro contratos iguais: avança UM por tarefa, o de menor id", () => {
    const p = aplicavel(
      planejarDatas({
        tarefa: tarefa(),
        pedido: { tarefaId: "x", dataReajuste: "2026-11-27", dataEncerramento: null },
        contratos: [contrato(10580), contrato(10574), contrato(10578), contrato(10576)],
      }),
    );
    expect(p.contrato?.id).toBe(10574);
  });

  it("⚠ e o contrato já avançado por uma tarefa irmã NÃO é avançado de novo", () => {
    // 10574 já está em 2027 (a tarefa irmã passou antes); sobram os outros.
    const p = aplicavel(
      planejarDatas({
        tarefa: tarefa(),
        pedido: { tarefaId: "x", dataReajuste: "2026-11-27", dataEncerramento: null },
        contratos: [contrato(10574, { fidelidade: "2027-11-27" }), contrato(10576)],
      }),
    );
    expect(p.contrato?.id).toBe(10576);
  });

  it("⚠ (1858) produtos diferentes: o valor da tarefa escolhe o contrato, não a ordem da lista", () => {
    const ev = contrato(10441, { fidelidade: "2026-11-06", antes: 89, valor: 93.08 });
    const sp = contrato(10378, { fidelidade: "2026-11-04", antes: 5800, valor: 6065.64 });
    const p = aplicavel(
      planejarDatas({
        tarefa: tarefa({ valor: 5800, dataDeReajuste: "2026-11-04" }),
        pedido: { tarefaId: "x", dataReajuste: "2026-11-04", dataEncerramento: null },
        contratos: [ev, sp],
      }),
    );
    expect(p.contrato?.id).toBe(10378);
  });

  it("a deriva de um dia entre as duas automações (+364 e +365) é tolerada", () => {
    const p = aplicavel(
      planejarDatas({
        tarefa: tarefa({ dataDeReajuste: "2026-12-10" }),
        pedido: { tarefaId: "x", dataReajuste: "2026-12-10", dataEncerramento: null },
        contratos: [contrato(3713, { fidelidade: "2026-12-11" })],
      }),
    );
    expect(p.contrato?.id).toBe(3713);
  });

  it("⚠ nenhum contrato com a fidelidade perto: o Conexa NÃO é tocado, e as datas da tarefa avançam", () => {
    const p = aplicavel(
      planejarDatas({
        tarefa: tarefa(),
        pedido: { tarefaId: "x", dataReajuste: "2026-11-27", dataEncerramento: null },
        contratos: [contrato(1, { fidelidade: "2027-11-27" }), contrato(2, { ativo: false })],
      }),
    );
    expect(p.contrato).toBeNull();
    expect(p.semContrato).toContain("nenhum contrato ativo");
    expect(p.escreverReajuste).toBe(true);
  });

  it("⚠ contrato encerrado nunca é escolhido", () => {
    const p = aplicavel(
      planejarDatas({
        tarefa: tarefa(),
        pedido: { tarefaId: "x", dataReajuste: "2026-11-27", dataEncerramento: null },
        contratos: [contrato(1, { ativo: false })],
      }),
    );
    expect(p.contrato).toBeNull();
  });
});

describe("apoios", () => {
  it("a chave da reserva é por tarefa e data de partida, e a sombra tem a dela", () => {
    expect(chaveDasDatas("t1", "2026-11-27")).toBe("datas:t1:2026-11-27");
    expect(chaveDasDatas("t1", "2026-11-27", true)).toBe("datas-sombra:t1:2026-11-27");
  });

  it("o comentário diz o que mudou, e o que NÃO mudou no Conexa e por quê", () => {
    const plano = aplicavel(
      planejarDatas({
        tarefa: tarefa(),
        pedido: { tarefaId: "x", dataReajuste: "2026-11-27", dataEncerramento: "2026-11-27" },
        contratos: [],
      }),
    );
    const c = comentarioDasDatas({
      plano,
      escreveuReajuste: true,
      escreveuEncerramento: true,
      fidelidadeNoConexa: "nao-tocada",
      erros: [],
    });
    expect(c).toContain("27/11/2026 → 27/11/2027");
    expect(c).toContain("Fidelidade no Conexa não alterada");
  });
});
