import { beforeEach, describe, expect, it, vi } from "vitest";

/** Redis de mentira, com o mínimo que o módulo usa. */
let guardado: Map<string, string>;
let quebrarRedis: boolean;

vi.mock("@/server/queue/conexao", () => ({
  getRedis: () => ({
    set: async (chave: string, valor: string) => {
      if (quebrarRedis) throw new Error("redis fora do ar");
      guardado.set(chave, valor);
      return "OK";
    },
    get: async (chave: string) => {
      if (quebrarRedis) throw new Error("redis fora do ar");
      return guardado.get(chave) ?? null;
    },
    del: async (chave: string) => {
      guardado.delete(chave);
      return 1;
    },
  }),
}));

const {
  comParadaVigiada,
  conferirParada,
  ehInterrupcao,
  limparPedido,
  paradaPedida,
  pedirParada,
} = await import("./cancelamento");

beforeEach(() => {
  guardado = new Map();
  quebrarRedis = false;
});

describe("recado de parada", () => {
  it("guarda quem pediu — a nota na conversa nomeia a pessoa", async () => {
    expect(await pedirParada("run-1", "Basílio")).toBe(true);
    expect(await paradaPedida("run-1")).toBe("Basílio");
  });

  it("cada execução tem o seu recado", async () => {
    await pedirParada("run-1", "Ana");
    expect(await paradaPedida("run-2")).toBeNull();
  });

  it("limpar apaga", async () => {
    await pedirParada("run-1", "Ana");
    await limparPedido("run-1");
    expect(await paradaPedida("run-1")).toBeNull();
  });

  it("Redis fora do ar é reportado a quem pediu, não engolido", async () => {
    // A tela precisa poder dizer "não consegui" em vez de mentir que parou.
    quebrarRedis = true;
    expect(await pedirParada("run-1", "Ana")).toBe(false);
  });

  it("mas a LEITURA falha em silêncio — não derruba o turno", async () => {
    // Instabilidade no Redis não pode matar um atendimento em andamento. O
    // pior caso vira "não parou", que é o mundo de antes desta funcionalidade.
    quebrarRedis = true;
    expect(await paradaPedida("run-1")).toBeNull();
    await expect(conferirParada("run-1")).resolves.toBeUndefined();
  });
});

describe("ponto de parada entre etapas", () => {
  it("deixa passar quando ninguém pediu", async () => {
    await expect(conferirParada("run-1")).resolves.toBeUndefined();
  });

  it("interrompe quando pediram", async () => {
    await pedirParada("run-1", "Ana");

    await expect(conferirParada("run-1")).rejects.toSatisfy(ehInterrupcao);
  });
});

describe("aborto durante a chamada ao modelo", () => {
  /** Uma "chamada ao modelo" que só termina quando o sinal aborta. */
  const chamadaLonga = (signal: AbortSignal) =>
    new Promise((_resolver, rejeitar) => {
      signal.addEventListener("abort", () =>
        rejeitar(Object.assign(new Error("Request was aborted."), { name: "AbortError" })),
      );
    });

  it("aborta o que está em voo, não só entre iterações", async () => {
    // É aqui que o turno passa quase todo o tempo: parar só entre etapas nunca
    // alcançaria um turno pendurado, que é justamente o que se quer matar.
    await pedirParada("run-1", "Ana");

    await expect(comParadaVigiada("run-1", chamadaLonga)).rejects.toSatisfy(
      ehInterrupcao,
    );
  });

  it("devolve o resultado quando ninguém pediu parada", async () => {
    expect(await comParadaVigiada("run-1", async () => "resposta")).toBe(
      "resposta",
    );
  });

  it("abort por OUTRO motivo continua sendo o erro que era", async () => {
    // Timeout do SDK e queda de rede também chegam como abort. Tratá-los como
    // interrupção faria o worker desistir de tentar de novo uma falha real.
    const erro = await comParadaVigiada("run-1", async () => {
      throw new Error("socket hang up");
    }).catch((e) => e);

    expect(ehInterrupcao(erro)).toBe(false);
    expect(erro.message).toBe("socket hang up");
  });
});
