import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O `jobId` fixo por conversa é o que faz o debounce agrupar mensagens — e é
 * também a origem da pior classe de bug deste projeto: o BullMQ **ignora em
 * silêncio** um `add` com jobId que já existe. Cada estado tem um desfecho
 * diferente, e errar um deles faz mensagem de cliente sumir sem rastro.
 */

type JobFalso = { estado: string; removido: boolean };

let jobExistente: JobFalso | null;
let adicionados: { jobId: string; delay: number }[];
/** Chave → valor do Redis dublado. */
let redis: Map<string, string>;

vi.mock("./conexao", () => ({
  getRedis: () => ({
    set: async (chave: string, valor: string) => {
      redis.set(chave, valor);
      return "OK";
    },
    multi: () => {
      const operacoes: string[] = [];
      const encadeado = {
        get(chave: string) {
          operacoes.push(chave);
          return encadeado;
        },
        del(chave: string) {
          operacoes.push(chave);
          return encadeado;
        },
        async exec() {
          const chave = operacoes[0];
          const valor = redis.get(chave) ?? null;
          redis.delete(chave);
          return [[null, valor], [null, 1]];
        },
      };
      return encadeado;
    },
  }),
}));

vi.mock("bullmq", () => ({
  Queue: class {
    async getJob() {
      if (!jobExistente) return null;
      const alvo = jobExistente;
      return {
        getState: async () => alvo.estado,
        remove: async () => {
          alvo.removido = true;
          jobExistente = null;
        },
      };
    }
    async add(_nome: string, _dados: unknown, opts: { jobId: string; delay: number }) {
      adicionados.push(opts);
      return { id: opts.jobId };
    }
  },
}));

const { agendarAtendimento, consumirPendente, idDoJob } = await import("./atendimento");

const dados = { chatwootConversationId: 55, agentId: "porta", inboxId: 1 };

beforeEach(() => {
  jobExistente = null;
  adicionados = [];
  redis = new Map();
});

describe("jobId por conversa", () => {
  it("não usa `:` — o BullMQ recusa esse caractere", () => {
    expect(idDoJob(55)).toBe("conversa-55");
    expect(idDoJob(55)).not.toContain(":");
  });

  it("sem job anterior, agenda com o debounce pedido", async () => {
    await agendarAtendimento(dados, 8);

    expect(adicionados).toEqual([{ jobId: "conversa-55", delay: 8000 }]);
  });

  it("debounce negativo não vira delay negativo", async () => {
    await agendarAtendimento(dados, -5);

    expect(adicionados[0].delay).toBe(0);
  });
});

describe("job anterior que ainda não rodou", () => {
  for (const estado of ["delayed", "waiting", "failed", "completed"]) {
    it(`remove o job em ${estado} e reagenda`, async () => {
      // Inclusive `failed` e `completed`: um job terminado com o mesmo id fazia
      // o `add` ser ignorado, e a conversa ficava muda pelas 24h do
      // removeOnFail (produção, 2026-07-31).
      jobExistente = { estado, removido: false };

      await agendarAtendimento(dados, 3);

      expect(adicionados).toHaveLength(1);
    });
  }
});

describe("mensagem que chega com o turno rodando", () => {
  /**
   * `active` é o único estado em que não dá para remover o job. O `add` seria
   * ignorado em silêncio, e a mensagem sumiria de vez: o agente responde ao
   * turno anterior, zera `aguardandoDesde` ao responder, e o vigia deixa de
   * vigiar justamente a mensagem que ninguém leu.
   */
  it("não tenta agendar por cima do job ativo", async () => {
    jobExistente = { estado: "active", removido: false };

    const r = await agendarAtendimento(dados, 3);

    expect(r).toBeNull();
    expect(adicionados).toEqual([]);
    expect(jobExistente.removido).toBe(false);
  });

  it("deixa o recado para o worker reagendar quando o turno acabar", async () => {
    jobExistente = { estado: "active", removido: false };

    await agendarAtendimento(dados, 3);

    expect(await consumirPendente(55)).toBe(true);
  });

  it("três mensagens durante o turno viram UM reagendamento", async () => {
    jobExistente = { estado: "active", removido: false };

    await agendarAtendimento(dados, 3);
    await agendarAtendimento(dados, 3);
    await agendarAtendimento(dados, 3);

    expect(await consumirPendente(55)).toBe(true);
    // Consumir apaga: o segundo worker a terminar não reagenda de novo.
    expect(await consumirPendente(55)).toBe(false);
  });

  it("sem recado, não há reagendamento", async () => {
    expect(await consumirPendente(55)).toBe(false);
  });

  it("o recado é por conversa, não global", async () => {
    jobExistente = { estado: "active", removido: false };
    await agendarAtendimento(dados, 3);

    expect(await consumirPendente(99)).toBe(false);
    expect(await consumirPendente(55)).toBe(true);
  });
});
