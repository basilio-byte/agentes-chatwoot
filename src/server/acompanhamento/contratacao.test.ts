import { describe, expect, it } from "vitest";

import {
  cobrancaDoContrato,
  cobrancaPaga,
  contratacaoDaTask,
  documentoAssinado,
  execucoesDaTask,
  linkDeAssinatura,
  type Chamada,
} from "./contratacao";

const TASK = "86adm4t1k";

function chamada(extra: Partial<Chamada>): Chamada {
  return {
    runId: "r1",
    toolName: "clickup_obter_tarefa",
    input: { taskId: TASK },
    output: {},
    createdAt: new Date("2026-11-10T12:00:00Z"),
    ...extra,
  };
}

/** O retorno real de `zapsign_gerar_contrato`, com um signatário. */
const SAIDA_ZAPSIGN = {
  documentoId: "doc-abc",
  nome: "EV LITORAL PJ",
  status: "pending",
  signatarios: [
    { signatarioId: "s1", nome: "Carla", situacao: "nao_abriu", linkParaAssinar: "https://zap/s1" },
  ],
};

/** O retorno real de `conexa_criar_contrato`. */
const SAIDA_CONEXA = {
  criado: true,
  contratoId: 12833,
  link: "https://seahubcoworking.conexa.app/index.php?r=vendaRecorrente/gerenciarContratos&idCliente=5996",
};

describe("execucoesDaTask", () => {
  it("amarra pelo taskId do input, que aparece em qualquer ferramenta do ClickUp", () => {
    const chamadas = [
      chamada({ runId: "r1" }),
      chamada({ runId: "r2", input: { taskId: "outra" } }),
      chamada({ runId: "r3", toolName: "clickup_comentar_tarefa" }),
    ];
    expect([...execucoesDaTask(chamadas, TASK)].sort()).toEqual(["r1", "r3"]);
  });

  it("task sem execução nenhuma devolve vazio", () => {
    expect(execucoesDaTask([], TASK).size).toBe(0);
  });
});

describe("contratacaoDaTask", () => {
  it("junta o documento da ZapSign e o contrato do Conexa da MESMA execução", () => {
    const chamadas = [
      chamada({}),
      chamada({ toolName: "zapsign_gerar_contrato", output: SAIDA_ZAPSIGN }),
      chamada({
        toolName: "conexa_criar_contrato",
        input: { clienteId: 5996, planoId: 151 },
        output: SAIDA_CONEXA,
      }),
    ];

    expect(contratacaoDaTask(chamadas, TASK)).toEqual({
      documentoZapSign: "doc-abc",
      linkAssinatura: "https://zap/s1",
      contratoConexa: 12833,
      clienteConexa: 5996,
    });
  });

  it("⚠ o contrato que JÁ EXISTIA vale igual — há contrato de verdade no ERP", () => {
    const chamadas = [
      chamada({}),
      chamada({
        toolName: "conexa_criar_contrato",
        input: { clienteId: 5996 },
        output: { criado: false, jaExistia: true, contratoId: 999, link: "x" },
      }),
    ];
    expect(contratacaoDaTask(chamadas, TASK).contratoConexa).toBe(999);
  });

  it("⚠ reprocessada: o documento MAIS RECENTE vence", () => {
    const chamadas = [
      chamada({ runId: "r1" }),
      chamada({
        runId: "r1",
        toolName: "zapsign_gerar_contrato",
        output: SAIDA_ZAPSIGN,
        createdAt: new Date("2026-11-10T12:00:00Z"),
      }),
      chamada({ runId: "r2" }),
      chamada({
        runId: "r2",
        toolName: "zapsign_gerar_contrato",
        createdAt: new Date("2026-11-10T18:00:00Z"),
        output: {
          ...SAIDA_ZAPSIGN,
          documentoId: "doc-novo",
          signatarios: [{ signatarioId: "s2", linkParaAssinar: "https://zap/s2" }],
        },
      }),
    ];
    const r = contratacaoDaTask(chamadas, TASK);
    expect(r.documentoZapSign).toBe("doc-novo");
    expect(r.linkAssinatura).toBe("https://zap/s2");
  });

  it("⚠ NÃO usa execução de outra task", () => {
    const chamadas = [
      chamada({ runId: "r9", input: { taskId: "outra" } }),
      // A chamada da ZapSign não leva `taskId` no input — quem amarra a
      // execução à task são as ferramentas do ClickUp do mesmo turno.
      chamada({
        runId: "r9",
        toolName: "zapsign_gerar_contrato",
        input: { modelo: "EV LITORAL PJ" },
        output: SAIDA_ZAPSIGN,
      }),
    ];
    expect(contratacaoDaTask(chamadas, TASK).documentoZapSign).toBeNull();
  });
});

describe("linkDeAssinatura", () => {
  it("devolve o link do único signatário", () => {
    expect(linkDeAssinatura(SAIDA_ZAPSIGN)).toBe("https://zap/s1");
  });

  it("⚠ com DOIS signatários não devolve nada: cada um tem o seu link", () => {
    expect(
      linkDeAssinatura({
        signatarios: [
          { linkParaAssinar: "https://zap/a" },
          { linkParaAssinar: "https://zap/b" },
        ],
      }),
    ).toBeNull();
  });

  it("sem signatário, nada", () => {
    expect(linkDeAssinatura({ signatarios: [] })).toBeNull();
    expect(linkDeAssinatura({})).toBeNull();
  });
});

describe("cobrancaDoContrato", () => {
  const cobrancas = [
    { id: 32132, status: "unpaid", faturaUrl: "https://conexa/f/aaa", vendas: [66423] },
    { id: 32200, status: "unpaid", faturaUrl: "https://conexa/f/bbb", vendas: [70000] },
  ];

  it("⚠ acha pela VENDA do contrato, não pela mais recente do cliente", () => {
    expect(cobrancaDoContrato(cobrancas, new Set([70000]))?.id).toBe(32200);
    expect(cobrancaDoContrato(cobrancas, new Set([66423]))?.id).toBe(32132);
  });

  it("entre as do contrato, a primeira é a que começa a contratação", () => {
    expect(cobrancaDoContrato(cobrancas, new Set([66423, 70000]))?.id).toBe(32132);
  });

  it("nenhuma venda do contrato: não inventa cobrança", () => {
    expect(cobrancaDoContrato(cobrancas, new Set([1]))).toBeNull();
  });
});

describe("cobrancaPaga", () => {
  it("só `paid` é pago", () => {
    expect(cobrancaPaga("paid")).toBe(true);
    expect(cobrancaPaga("unpaid")).toBe(false);
    expect(cobrancaPaga("negotiated")).toBe(false);
    expect(cobrancaPaga("cancelled")).toBe(false);
    expect(cobrancaPaga(null)).toBe(false);
  });
});

describe("documentoAssinado", () => {
  it("o status do documento manda", () => {
    expect(documentoAssinado({ status: "signed", signatarios: [] })).toBe(true);
  });

  it("todos os signatários assinaram", () => {
    expect(
      documentoAssinado({ status: "pending", signatarios: [{ situacao: "assinou" }] }),
    ).toBe(true);
  });

  it("um que não assinou segura o documento", () => {
    expect(
      documentoAssinado({
        status: "pending",
        signatarios: [{ situacao: "assinou" }, { situacao: "abriu" }],
      }),
    ).toBe(false);
  });

  it("⚠ documento SEM signatário não é assinado — `every` de lista vazia é verdadeiro", () => {
    expect(documentoAssinado({ status: "pending", signatarios: [] })).toBe(false);
    expect(documentoAssinado({ status: "pending" })).toBe(false);
  });

  it("recusado ou expirado não é assinado", () => {
    expect(documentoAssinado({ signatarios: [{ situacao: "recusou" }] })).toBe(false);
    expect(documentoAssinado({ signatarios: [{ situacao: "expirou" }] })).toBe(false);
  });
});
