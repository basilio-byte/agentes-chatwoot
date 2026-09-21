import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Encerrar execução é escrever por cima do desfecho de um turno — e errar para
 * o lado de encerrar uma execução VIVA a faria gravar depois sobre o nosso
 * erro, ou pior, esconder uma falha real. Por isso as travas daqui: a idade, o
 * `status` no where e o prazo do recado.
 */

type Run = { id: string; status: string; createdAt: Date; error?: string; finishedAt?: Date };

let runs: Run[];
let recados: { runId: string; quem: string }[];
let recadoPendura: boolean;
let agendamentosFechados: Date[];
/** Simula o turno que terminou entre a leitura e a escrita do encerramento. */
let terminaAntesDaEscrita: string | null;

vi.mock("@/lib/db", () => ({
  db: {
    agentRun: {
      findMany: async ({ where }: { where: { status: string; createdAt: { lt: Date } } }) =>
        runs
          .filter((r) => r.status === where.status && r.createdAt < where.createdAt.lt)
          .map((r) => ({ id: r.id, createdAt: r.createdAt })),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: Partial<Run>;
      }) => {
        if (terminaAntesDaEscrita === where.id) {
          const r = runs.find((x) => x.id === where.id);
          if (r) r.status = "SUCCESS";
        }
        const alvo = runs.filter((r) => r.id === where.id && r.status === where.status);
        for (const r of alvo) Object.assign(r, data);
        return { count: alvo.length };
      },
    },
  },
}));

vi.mock("@/server/agents/cancelamento", () => ({
  pedirParada: (runId: string, quem: string) => {
    recados.push({ runId, quem });
    return recadoPendura ? new Promise<boolean>(() => {}) : Promise.resolve(true);
  },
}));

vi.mock("@/server/queue/agendamento-worker", () => ({
  encerrarOcorrenciasInterrompidas: async (corte: Date) => {
    agendamentosFechados.push(corte);
    return 0;
  },
}));

const { encerrarOrfas, esquecerUltimaConferenciaDeOrfas, CONFERIR_ORFAS_A_CADA_MS, QUEM_ENCERRA } =
  await import("./orfas");
const { IDADE_DE_ZUMBI_MS } = await import("./limites");

const AGORA = new Date("2026-09-21T15:40:00Z");
const haMinutos = (min: number) => new Date(AGORA.getTime() - min * 60_000);

beforeEach(() => {
  esquecerUltimaConferenciaDeOrfas();
  recados = [];
  recadoPendura = false;
  agendamentosFechados = [];
  terminaAntesDaEscrita = null;
  runs = [
    { id: "agosto", status: "RUNNING", createdAt: new Date("2026-08-21T20:35:00Z") },
    { id: "deploy", status: "RUNNING", createdAt: haMinutos(70) },
    // O contrato de 16 minutos que terminou bem em 26/08: vivo, não se toca.
    { id: "contrato-vivo", status: "RUNNING", createdAt: haMinutos(16) },
    { id: "velha-mas-terminou", status: "SUCCESS", createdAt: haMinutos(300) },
  ];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("encerrarOrfas", () => {
  it("encerra como ERRO só o que está rodando além da régua", async () => {
    const rodada = await encerrarOrfas(AGORA);

    expect(rodada).toMatchObject({ acao: "conferido", execucoes: 2 });
    const porId = Object.fromEntries(runs.map((r) => [r.id, r]));
    expect(porId.agosto.status).toBe("ERROR");
    expect(porId.deploy.status).toBe("ERROR");
    expect(porId.deploy.error).toContain("70 minutos");
    expect(porId.deploy.finishedAt).toEqual(AGORA);
    expect(porId["contrato-vivo"].status).toBe("RUNNING");
    expect(porId["velha-mas-terminou"].status).toBe("SUCCESS");
  });

  it("⚠ a régua é de 30 minutos: o turno de 16 que terminou bem não pode cair nela", () => {
    expect(IDADE_DE_ZUMBI_MS).toBe(30 * 60_000);
    // 945 s: o turno mais longo que terminou bem, medido em 30 dias.
    expect(IDADE_DE_ZUMBI_MS).toBeGreaterThanOrEqual(945_000 * 1.5);
  });

  it("deixa o recado de parada, para o turno vivo e pendurado também parar", async () => {
    await encerrarOrfas(AGORA);
    expect(recados.map((r) => r.runId).sort()).toEqual(["agosto", "deploy"]);
    expect(recados[0].quem).toBe(QUEM_ENCERRA);
    // Vai depois de "interrompida no painel por", no erro e na nota interna.
    expect(`interrompida no painel por ${QUEM_ENCERRA}`).toContain("passou de 30 minutos");
  });

  it("turno que terminou entre a leitura e a escrita fica com o desfecho dele", async () => {
    terminaAntesDaEscrita = "deploy";
    const rodada = await encerrarOrfas(AGORA);
    expect(rodada.execucoes).toBe(1);
    expect(runs.find((r) => r.id === "deploy")?.status).toBe("SUCCESS");
  });

  it("⚠ Redis sem resposta não pendura o vigia: o recado tem prazo", async () => {
    vi.useFakeTimers();
    recadoPendura = true;
    const rodando = encerrarOrfas(AGORA);
    await vi.advanceTimersByTimeAsync(5_000);
    const rodada = await rodando;
    expect(rodada.execucoes).toBe(2);
  });

  it("fecha também as ocorrências de agendamento, com o mesmo corte", async () => {
    await encerrarOrfas(AGORA);
    expect(agendamentosFechados).toEqual([new Date(AGORA.getTime() - IDADE_DE_ZUMBI_MS)]);
  });

  it("confere de dez em dez minutos, não a cada minuto do vigia", async () => {
    await encerrarOrfas(AGORA);
    const logo = await encerrarOrfas(new Date(AGORA.getTime() + 60_000));
    expect(logo.acao).toBe("cedo");
    const depois = await encerrarOrfas(new Date(AGORA.getTime() + CONFERIR_ORFAS_A_CADA_MS));
    expect(depois.acao).toBe("conferido");
  });
});
