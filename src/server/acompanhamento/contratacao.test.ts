import { describe, expect, it } from "vitest";

import {
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
    input: { tarefaId: TASK },
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
  it("amarra pelo tarefaId do input, que aparece em qualquer ferramenta do ClickUp", () => {
    const chamadas = [
      chamada({ runId: "r1" }),
      chamada({ runId: "r2", input: { tarefaId: "outra" } }),
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
      chamada({ runId: "r9", input: { tarefaId: "outra" } }),
      // A chamada da ZapSign não leva `tarefaId` no input — quem amarra a
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

/**
 * ⚠⚠ O defeito que os testes escondiam até 11/11/2026: as chamadas de mentira
 * usavam `taskId`, e a ferramenta de verdade manda `tarefaId`. Nenhuma execução
 * casava com task nenhuma em produção, e o acompanhamento nunca teria enviado
 * nada. Este caso usa o input REAL, copiado da execução de 10/11.
 */
describe("o nome do parâmetro é `tarefaId`", () => {
  it("casa com o input real da ferramenta do ClickUp", () => {
    const chamadas = [
      chamada({
        runId: "real",
        toolName: "clickup_obter_tarefa",
        input: { tarefaId: "17twvjx2j2w", incluirComentarios: true },
      }),
    ];
    expect(execucoesDaTask(chamadas, "17twvjx2j2w")).toEqual(new Set(["real"]));
  });

  it("aceita `taskId` também, para a ferramenta que um dia use o outro nome", () => {
    const chamadas = [chamada({ runId: "r", input: { taskId: "abc" } })];
    expect(execucoesDaTask(chamadas, "abc")).toEqual(new Set(["r"]));
  });
});

/**
 * Achado no primeiro teste limpo do Diego (11/11/2026): a task foi
 * reprocessada, o documento da ZapSign JÁ existia, e o agente — obedecendo o
 * prompt — não gerou outro: só consultou. O acompanhamento achou contrato e
 * cobrança e parou em "aguardando o link de assinatura", com o link existindo.
 */
describe("documento que já existia conta igual", () => {
  it("⚠ `zapsign_ver_documento` entrega documento e link de assinatura", () => {
    const chamadas = [
      chamada({
        runId: "r",
        toolName: "clickup_obter_tarefa",
        input: { tarefaId: "17twvjx2kmm" },
      }),
      chamada({
        runId: "r",
        toolName: "zapsign_ver_documento",
        input: { documentoId: "751b0293" },
        output: {
          documentoId: "751b0293",
          status: "pending",
          signatarios: [
            {
              nome: "Tayná",
              situacao: "nao_abriu",
              linkParaAssinar: "https://app.zapsign.com.br/verificar/5159d047",
            },
          ],
        },
      }),
    ];

    const r = contratacaoDaTask(chamadas, "17twvjx2kmm");
    expect(r.documentoZapSign).toBe("751b0293");
    expect(r.linkAssinatura).toBe("https://app.zapsign.com.br/verificar/5159d047");
  });
});
