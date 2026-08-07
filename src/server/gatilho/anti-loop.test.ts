import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Redis falso em memória, mesmo padrão de `queue/atendimento.test.ts`: só o
 * que este módulo usa (`set` com EX/NX, `incr`, `expire`), sem TTL de verdade
 * — os testes de expiração ficam a cargo do `anti-loop.ts` chamar os comandos
 * certos, não de esperar o tempo passar.
 */
let dados: Map<string, string>;

vi.mock("@/server/queue/conexao", () => ({
  getRedis: () => ({
    set: async (
      chave: string,
      valor: string,
      _ex: "EX",
      _ttl: number,
      nx: "NX",
    ) => {
      if (nx === "NX" && dados.has(chave)) return null;
      dados.set(chave, valor);
      return "OK";
    },
    incr: async (chave: string) => {
      const atual = Number(dados.get(chave) ?? "0") + 1;
      dados.set(chave, String(atual));
      return atual;
    },
    expire: async () => 1,
  }),
}));

const { avaliarGatilho, TETO_DE_EXECUCOES_NA_JANELA } = await import("./anti-loop");

beforeEach(() => {
  dados = new Map();
});

describe("cooldown por recurso", () => {
  it("primeira chamada para um recurso passa", async () => {
    const r = await avaliarGatilho("agente-1", { task_id: "abc" });
    expect(r.pode).toBe(true);
  });

  it("segunda chamada para o MESMO recurso, logo em seguida, é barrada", async () => {
    await avaliarGatilho("agente-1", { task_id: "abc" });
    const r = await avaliarGatilho("agente-1", { task_id: "abc" });

    expect(r).toEqual({ pode: false, motivo: "cooldown_do_recurso" });
  });

  it("recurso DIFERENTE não é afetado pelo cooldown do outro", async () => {
    await avaliarGatilho("agente-1", { task_id: "abc" });
    const r = await avaliarGatilho("agente-1", { task_id: "xyz" });

    expect(r.pode).toBe(true);
  });

  it("agente DIFERENTE não é afetado pelo cooldown do outro agente", async () => {
    await avaliarGatilho("agente-1", { task_id: "abc" });
    const r = await avaliarGatilho("agente-2", { task_id: "abc" });

    expect(r.pode).toBe(true);
  });

  /**
   * O caso que a trava existe para pegar: o agente reage ao evento original
   * mudando a mesma tarefa, o que dispara um evento de OUTRO TIPO para a
   * mesma tarefa. Se a chave incluísse o eventType, isso escaparia da trava.
   */
  it("eventos de tipos diferentes para o MESMO recurso ainda colidem no cooldown", async () => {
    await avaliarGatilho("agente-1", { task_id: "abc", event: "taskUpdated" });
    const r = await avaliarGatilho("agente-1", {
      task_id: "abc",
      event: "taskCommentPosted",
    });

    expect(r).toEqual({ pode: false, motivo: "cooldown_do_recurso" });
  });

  it("payload sem chave de recurso reconhecível não aciona o cooldown", async () => {
    const a = await avaliarGatilho("agente-1", { algo: "sem id" });
    const b = await avaliarGatilho("agente-1", { algo: "sem id" });

    expect(a.pode).toBe(true);
    expect(b.pode).toBe(true);
  });
});

describe("teto global por agente", () => {
  it("dentro do teto, passa", async () => {
    for (let i = 0; i < TETO_DE_EXECUCOES_NA_JANELA; i++) {
      const r = await avaliarGatilho("agente-1", { task_id: `t-${i}` });
      expect(r.pode).toBe(true);
    }
  });

  it("estourar o teto barra a chamada seguinte, com o motivo certo", async () => {
    for (let i = 0; i < TETO_DE_EXECUCOES_NA_JANELA; i++) {
      await avaliarGatilho("agente-1", { task_id: `t-${i}` });
    }

    const r = await avaliarGatilho("agente-1", { task_id: "t-estourou" });

    expect(r).toEqual({
      pode: false,
      motivo: "teto_de_execucoes",
      execucoesNaJanela: TETO_DE_EXECUCOES_NA_JANELA + 1,
    });
  });

  it("chamada barrada pelo cooldown NÃO conta para o teto", async () => {
    // Todas com o mesmo recurso: só a primeira passa do cooldown; se as
    // demais contassem para o teto, o número de execuções reais divergiria
    // do que aparece no painel.
    for (let i = 0; i < TETO_DE_EXECUCOES_NA_JANELA + 5; i++) {
      await avaliarGatilho("agente-1", { task_id: "sempre-o-mesmo" });
    }

    // Ainda deve caber espaço no teto, porque só UMA passou do cooldown.
    const r = await avaliarGatilho("agente-1", { task_id: "outro-recurso" });
    expect(r.pode).toBe(true);
  });

  it("agente DIFERENTE tem teto independente", async () => {
    for (let i = 0; i < TETO_DE_EXECUCOES_NA_JANELA; i++) {
      await avaliarGatilho("agente-1", { task_id: `t-${i}` });
    }

    const r = await avaliarGatilho("agente-2", { task_id: "t-0" });
    expect(r.pode).toBe(true);
  });
});
