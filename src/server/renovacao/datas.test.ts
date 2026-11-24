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

  it("⚠ a ação NOVA do ClickUp (24/11/2026): variáveis não preenchidas e a tarefa no `payload`", () => {
    // O endereço colado com `?taskid={Task ID}` chega com o texto cru, e o `id`
    // do topo é o da EXECUÇÃO da automação — não pode virar id de tarefa.
    const p = lerPedidoDasDatas(
      {
        taskid: "{Task ID}",
        datadereajuste: "{DATA DE REAJUSTE}",
        dataencerramento: "{DATA DE ENCERRAMENTO CONTRATO [BASE CLIENTES]}",
      },
      {
        id: "3f8e2a7c-1b2d-4c5e-9f00-aabbccddeeff",
        trigger_id: "t1",
        date: 1795534559111,
        payload: {
          id: "86adugf6r",
          fields: [
            { field_id: "0231d769-5063-439d-8b03-ad660c6bada5", value: 1827644400000 },
            { field_id: "885c7420-baa9-4125-95cd-53934b47b147", value: "1796799600000" },
          ],
        },
      },
    );
    expect(p).toEqual({ tarefaId: "86adugf6r", dataReajuste: "2027-12-01", dataEncerramento: "2026-12-09" });
  });

  it("a ação antiga (`auto_id`, `custom_fields`) também dá as datas pelo `payload`", () => {
    const p = lerPedidoDasDatas(
      {},
      {
        auto_id: "a1",
        trigger_id: "t1",
        payload: {
          id: "86adjmaqg",
          custom_fields: [{ id: "0231d769-5063-439d-8b03-ad660c6bada5", value: "1795762800000" }],
        },
      },
    );
    expect(p.tarefaId).toBe("86adjmaqg");
    expect(p.dataReajuste).toBe("2026-11-27");
    expect(p.dataEncerramento).toBeNull();
  });

  it("⚠ o `id` do topo só vale sem `payload`; com `payload` sem id, não há tarefa", () => {
    expect(lerPedidoDasDatas({}, { id: "abc123" }).tarefaId).toBe("abc123");
    expect(lerPedidoDasDatas({}, { id: "evento-da-automacao", payload: {} }).tarefaId).toBeNull();
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
    // ⚠ E a data nova sai do CONEXA: a deriva de um dia some, em vez de seguir adiante.
    expect(p.reajusteNovo).toBe("2027-12-11");
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

describe("planejarDatas: a data sai da fidelidade do Conexa (24/11/2026)", () => {
  // O caso real: a DATA DE REAJUSTE de 51 tarefas foi gravada em massa como
  // 01/12/2027; o contrato 10654 (cliente 5083) tem fidelidade 08/12/2026 e foi
  // reajustado de R$ 99,90 para R$ 104,53.
  const emMassa = (extra: Partial<TarefaParaDatas> = {}) =>
    tarefa({ valor: 104.53, dataDeReajuste: "2027-12-01", ...extra });
  const pedidoEmMassa = { tarefaId: "86adugf6r", dataReajuste: "2027-12-01", dataEncerramento: null };
  const c10654 = (extra: Partial<ContratoParaDatas> = {}) =>
    contrato(10654, { fidelidade: "2026-12-08", valor: 104.53, antes: 99.9, ...extra });
  const HOJE = "2026-12-10";

  it("⚠ data gravada em massa: o contrato é ligado pelo VALOR e a data volta à fidelidade nova", () => {
    const p = aplicavel(
      planejarDatas({ tarefa: emMassa(), pedido: pedidoEmMassa, contratos: [c10654()], hoje: HOJE }),
    );
    expect(p.contrato).toEqual({ id: 10654, fidelidadeAtual: "2026-12-08", fidelidadeNova: "2027-12-08" });
    // Não 2028: "data da tarefa + 1 ano" pularia a renovação de 2027.
    expect(p.reajusteNovo).toBe("2027-12-08");
    expect(p.escreverReajuste).toBe(true);
    expect(p.avisos.join(" ")).toContain("ligado pelo valor");
  });

  it("o valor de ANTES do lote também liga (a tarefa que ainda não recebeu a propagação)", () => {
    const p = aplicavel(
      planejarDatas({
        tarefa: emMassa({ valor: 99.9 }),
        pedido: pedidoEmMassa,
        contratos: [c10654()],
        hoje: HOJE,
      }),
    );
    expect(p.contrato?.id).toBe(10654);
  });

  it("sem `hoje`, o passo pelo valor não roda (o comportamento de antes)", () => {
    const p = aplicavel(planejarDatas({ tarefa: emMassa(), pedido: pedidoEmMassa, contratos: [c10654()] }));
    expect(p.contrato).toBeNull();
  });

  it("⚠ o contrato JÁ avançado não é ligado de novo, e a data futura não ganha mais um ano", () => {
    const p = aplicavel(
      planejarDatas({
        tarefa: emMassa(),
        pedido: pedidoEmMassa,
        contratos: [c10654({ fidelidade: "2027-12-08" })],
        hoje: HOJE,
      }),
    );
    expect(p.contrato).toBeNull();
    expect(p.escreverReajuste).toBe(false);
    expect(p.avisos.join(" ")).toContain("pularia uma renovação");
  });

  it("⚠ valor que não bate com contrato nenhum não liga", () => {
    const p = aplicavel(
      planejarDatas({
        tarefa: emMassa({ valor: 3367.26 }),
        pedido: pedidoEmMassa,
        contratos: [c10654()],
        hoje: HOJE,
      }),
    );
    expect(p.contrato).toBeNull();
  });

  it("dois contratos diferentes com o valor da tarefa: ninguém é escolhido, a equipe indica", () => {
    const p = aplicavel(
      planejarDatas({
        tarefa: emMassa(),
        pedido: pedidoEmMassa,
        contratos: [c10654(), contrato(10700, { fidelidade: "2026-12-20", valor: 104.53, antes: 99.9 })],
        hoje: HOJE,
      }),
    );
    expect(p.contrato).toBeNull();
    expect(p.semContrato).toContain("indicar");
  });

  it("contratos EQUIVALENTES pelo valor (os quatro do 5051): vai o de menor id", () => {
    const iguais = [10580, 10574, 10578].map((id) =>
      contrato(id, { fidelidade: "2026-11-27", valor: 104.53, antes: 99.9 }),
    );
    const p = aplicavel(
      planejarDatas({ tarefa: emMassa(), pedido: pedidoEmMassa, contratos: iguais, hoje: HOJE }),
    );
    expect(p.contrato?.id).toBe(10574);
  });

  it("a tarefa já mostra a fidelidade nova: não reescreve", () => {
    const p = aplicavel(
      planejarDatas({
        tarefa: tarefa({ dataDeReajuste: "2027-11-27" }),
        pedido: { tarefaId: "x", dataReajuste: "2026-11-27", dataEncerramento: null },
        contratos: [contrato(10574)],
        hoje: "2026-11-28",
      }),
    );
    expect(p.contrato?.id).toBe(10574);
    expect(p.escreverReajuste).toBe(false);
  });

  it("sem contrato (tarefa da ONE) e data do ciclo de agora: avança +1 ano, como sempre", () => {
    const p = aplicavel(
      planejarDatas({
        tarefa: tarefa({ dataDeReajuste: "2026-12-05" }),
        pedido: { tarefaId: "x", dataReajuste: "2026-12-05", dataEncerramento: null },
        contratos: [],
        hoje: HOJE,
      }),
    );
    expect(p.reajusteNovo).toBe("2027-12-05");
    expect(p.escreverReajuste).toBe(true);
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
