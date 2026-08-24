import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { ExecucaoInterrompida } from "@/server/agents/cancelamento";
import type { JobAgendamento } from "./agendamento";

/**
 * O agendamento roda sem ninguém olhando, e é isso que torna as travas daqui
 * críticas: um agendamento quebrado que se repete de hora em hora queima
 * crédito por dias antes de alguém notar.
 */

type Schedule = {
  id: string;
  agentId: string;
  nome: string;
  cron: string;
  instrucao: string;
  enabled: boolean;
  toleranciaMinutos: number;
  falhasConsecutivas: number;
  agent: { active: boolean; archivedAt: Date | null };
};

let schedule: Schedule | null;
/** Atualizações aplicadas na linha do agendamento, na ordem. */
let updates: Record<string, unknown>[];
/** Entregas registradas: {externalId, resultado, detalhe}. */
let entregas: { externalId: string; resultado?: string; detalhe?: string }[];
/** Chaves de entrega já usadas — simula a unique do Postgres. */
let entregasVistas: Set<string>;
let travaOcupada: boolean;
let agendadoresRemovidos: string[];
/** O que `executarAgente` deve fazer nesta chamada. */
let comportamentoDoAgente: "ok" | "falha" | "interrompida";
let execucoes: number;

vi.mock("@/lib/db", () => ({
  db: {
    agentSchedule: {
      findUnique: async () => schedule,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        if (schedule) {
          if (data.falhasConsecutivas && typeof data.falhasConsecutivas === "object") {
            schedule.falhasConsecutivas += 1;
          } else if (data.falhasConsecutivas === 0) {
            schedule.falhasConsecutivas = 0;
          }
          if (typeof data.enabled === "boolean") schedule.enabled = data.enabled;
        }
        return { falhasConsecutivas: schedule?.falhasConsecutivas ?? 0 };
      },
    },
    webhookEvent: {
      create: async ({ data }: { data: { externalId: string } }) => {
        if (entregasVistas.has(data.externalId)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        entregasVistas.add(data.externalId);
        entregas.push({ externalId: data.externalId });
        return { id: `ev-${entregas.length}` };
      },
      update: async ({ data }: { data: { resultado?: string; detalhe?: string } }) => {
        const ultima = entregas.at(-1);
        if (ultima) Object.assign(ultima, data);
        return data;
      },
    },
    toolCall: { count: async () => 0 },
  },
}));

vi.mock("./conexao", () => ({
  getRedis: () => ({
    set: async () => (travaOcupada ? null : "OK"),
    del: async () => 1,
  }),
}));

vi.mock("./agendamento", () => ({
  removerAgendador: async (id: string) => {
    agendadoresRemovidos.push(id);
  },
}));

vi.mock("@/server/agents/runner", () => ({
  executarAgente: async () => {
    execucoes++;
    if (comportamentoDoAgente === "falha") throw new Error("integração fora do ar");
    if (comportamentoDoAgente === "interrompida") {
      throw new ExecucaoInterrompida("run-1", "Basílio");
    }
    return { runId: "run-1", toolCalls: [], iteracoes: 1 };
  },
}));

const { processarAgendamento, FALHAS_ATE_DESLIGAR } = await import(
  "./agendamento-worker"
);

const job = () =>
  ({ data: { scheduleId: "s1", agentId: "a1" } }) as Job<JobAgendamento>;

/** Uma expressão de minuto em minuto: a ocorrência anterior é sempre recente. */
const AGORA_MESMO = "* * * * *";

beforeEach(() => {
  schedule = {
    id: "s1",
    agentId: "a1",
    nome: "Resumo diário",
    cron: AGORA_MESMO,
    instrucao: "Confira os contratos que vencem hoje.",
    enabled: true,
    toleranciaMinutos: 60,
    falhasConsecutivas: 0,
    agent: { active: true, archivedAt: null },
  };
  updates = [];
  entregas = [];
  entregasVistas = new Set();
  travaOcupada = false;
  agendadoresRemovidos = [];
  comportamentoDoAgente = "ok";
  execucoes = 0;
});

const ultimaEntrega = () => entregas.at(-1);

describe("execução normal", () => {
  it("roda o agente e registra o desfecho", async () => {
    await processarAgendamento(job());

    expect(execucoes).toBe(1);
    expect(ultimaEntrega()?.resultado).toBe("executado");
    expect(updates.at(-1)?.ultimoResultado).toBe("executado");
  });

  it("zera o placar de falhas ao dar certo", async () => {
    schedule!.falhasConsecutivas = 2;

    await processarAgendamento(job());

    expect(updates.at(-1)?.falhasConsecutivas).toBe(0);
  });
});

describe("o que não deve rodar", () => {
  it("agendamento desligado não chama o modelo", async () => {
    schedule!.enabled = false;

    await processarAgendamento(job());

    expect(execucoes).toBe(0);
    expect(ultimaEntrega()?.resultado).toBe("pulado");
  });

  it("agente desligado não chama o modelo", async () => {
    schedule!.agent.active = false;

    await processarAgendamento(job());

    expect(execucoes).toBe(0);
    expect(ultimaEntrega()?.resultado).toBe("pulado");
  });

  it("ocorrência atrasada demais é pulada, não executada tarde", async () => {
    // Diário às 9h com tolerância de 1h: rodando fora dessa janela, o agente
    // agiria sobre um contexto que já passou.
    schedule!.cron = "0 9 * * *";
    schedule!.toleranciaMinutos = 60;
    vi.setSystemTime(new Date("2026-08-21T18:00:00Z")); // 15h em São Paulo

    await processarAgendamento(job());

    expect(execucoes).toBe(0);
    expect(ultimaEntrega()?.resultado).toBe("pulado");
    expect(ultimaEntrega()?.detalhe).toContain("atrasada");
    vi.useRealTimers();
  });

  it("execução anterior ainda rodando trava a próxima", async () => {
    // Sem isto, um agendamento curto com turno longo empilha execuções até
    // derrubar o worker.
    travaOcupada = true;

    await processarAgendamento(job());

    expect(execucoes).toBe(0);
    expect(ultimaEntrega()?.detalhe).toContain("ainda está rodando");
  });

  it("a mesma ocorrência entregue duas vezes só roda uma", async () => {
    // A chave de entrega carrega a ocorrência: reentrega do BullMQ não pode
    // custar uma execução paga.
    await processarAgendamento(job());
    await processarAgendamento(job());

    expect(execucoes).toBe(1);
  });
});

describe("agendamento quebrado se desliga sozinho", () => {
  it("conta falhas e desliga ao bater o teto", async () => {
    comportamentoDoAgente = "falha";
    schedule!.falhasConsecutivas = FALHAS_ATE_DESLIGAR - 1;

    // Falha antes de qualquer tool relança, para o BullMQ tentar de novo.
    await expect(processarAgendamento(job())).rejects.toThrow();

    expect(schedule!.enabled).toBe(false);
    expect(updates.some((u) => u.pausadoAutomaticamenteMotivo)).toBe(true);
  });

  it("e sai do relógio junto — desligar só no banco continuaria disparando", async () => {
    comportamentoDoAgente = "falha";
    schedule!.falhasConsecutivas = FALHAS_ATE_DESLIGAR - 1;

    await expect(processarAgendamento(job())).rejects.toThrow();

    expect(agendadoresRemovidos).toContain("s1");
  });

  it("uma falha isolada não desliga nada", async () => {
    comportamentoDoAgente = "falha";

    await expect(processarAgendamento(job())).rejects.toThrow();

    expect(schedule!.enabled).toBe(true);
    expect(agendadoresRemovidos).toEqual([]);
  });

  it("pulado NÃO conta como falha — o sistema funcionando não é defeito", async () => {
    schedule!.enabled = false;
    schedule!.falhasConsecutivas = FALHAS_ATE_DESLIGAR - 1;

    await processarAgendamento(job());

    expect(updates.at(-1)?.falhasConsecutivas).toBeUndefined();
    expect(agendadoresRemovidos).toEqual([]);
  });
});

describe("parada pelo painel", () => {
  it("não relança — o BullMQ não pode repetir o turno", async () => {
    comportamentoDoAgente = "interrompida";

    await expect(processarAgendamento(job())).resolves.toBeUndefined();
    expect(ultimaEntrega()?.resultado).toBe("interrompido");
  });

  it("e não conta como falha do agendamento", async () => {
    // Parar é decisão de alguém, não agendamento quebrado.
    comportamentoDoAgente = "interrompida";
    schedule!.falhasConsecutivas = FALHAS_ATE_DESLIGAR - 1;

    await processarAgendamento(job());

    expect(schedule!.enabled).toBe(true);
  });
});
