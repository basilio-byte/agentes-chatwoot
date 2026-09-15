import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { JobConversaEncerrada } from "./conversa-encerrada";
import type { EntradaExecucao } from "@/server/agents/runner";
import { ExecucaoInterrompida } from "@/server/agents/cancelamento";

/**
 * O que este worker não pode errar: gastar modelo em atendimento que nenhuma
 * pessoa respondeu, avaliar o atendimento errado (o de agosto no lugar do de
 * hoje) e reexecutar depois de já ter gravado no CRM.
 */

type Msg = {
  id: number;
  content: string | null;
  message_type: number;
  private?: boolean;
  created_at: number;
  sender?: { type?: string; name?: string } | null;
};

const RESOLVIDA_EM = 1_789_485_438;

let gatilho: {
  id: string;
  agentId: string;
  enabled: boolean;
  exigeAtendimentoHumano: boolean;
  contasDeAutomacao: string[];
  agent: { active: boolean; archivedAt: Date | null };
} | null;
let leituraConfigurada: boolean;
let paginas: Map<number | undefined, Msg[]>;
let pedidosDePagina: (number | undefined)[];
let leituraFalha: Error | null;
let desfechos: { resultado: string; detalhe: string }[];
let toolCallCount: number;
let entrada: EntradaExecucao | null;
let execucao: {
  resultado?: { runId: string; toolCalls: unknown[]; iteracoes: number };
  erro?: Error & { runId?: string };
};

vi.mock("@/lib/db", () => ({
  db: {
    gatilhoDeConversa: {
      findUnique: async () => gatilho,
      update: async () => ({}),
    },
    webhookEvent: {
      update: async ({ data }: { data: { resultado: string; detalhe: string } }) => {
        desfechos.push({ resultado: data.resultado, detalhe: data.detalhe });
      },
    },
    conversation: { findUnique: async () => ({ id: "conversa-local" }) },
    toolCall: { count: async () => toolCallCount },
  },
}));

vi.mock("@/server/agents/runner", () => ({
  executarAgente: async (recebida: EntradaExecucao) => {
    entrada = recebida;
    if (execucao.erro) throw execucao.erro;
    return execucao.resultado;
  },
}));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteDeLeitura: async () =>
    leituraConfigurada
      ? {
          config: { baseUrl: "https://chatwoot.test", accountId: 1 },
          cliente: {
            listarMensagensAntes: async (_conversa: number, antesDe?: number) => {
              pedidosDePagina.push(antesDe);
              if (leituraFalha) throw leituraFalha;
              return paginas.get(antesDe) ?? [];
            },
          },
        }
      : null,
}));

const { processarConversaEncerrada } = await import("./conversa-encerrada-worker");

const job = () =>
  ({
    data: {
      gatilhoId: "gatilho-1",
      agentId: "avaliador",
      webhookEventId: "entrega-1",
      chatwootConversationId: 13498,
      inboxId: 29,
      resolvidaEm: RESOLVIDA_EM,
      contatoNome: "Maria",
      telefone: "+558487654321",
    },
  }) as Job<JobConversaEncerrada>;

const cliente = (id: number, texto: string, created_at = RESOLVIDA_EM - 900): Msg => ({
  id,
  content: texto,
  message_type: 0,
  created_at,
  sender: { type: "contact", name: "Maria" },
});
const pessoa = (id: number, nome: string, texto: string, extra: Partial<Msg> = {}): Msg => ({
  id,
  content: texto,
  message_type: 1,
  created_at: RESOLVIDA_EM - 600,
  sender: { type: "user", name: nome },
  ...extra,
});
const atividade = (id: number, texto: string, created_at: number): Msg => ({
  id,
  content: texto,
  message_type: 2,
  created_at,
  sender: null,
});

beforeEach(() => {
  gatilho = {
    id: "gatilho-1",
    agentId: "avaliador",
    enabled: true,
    exigeAtendimentoHumano: true,
    contasDeAutomacao: ["Basílio Oliveira"],
    agent: { active: true, archivedAt: null },
  };
  leituraConfigurada = true;
  // Página mais nova: o atendimento de hoje. Página anterior: a resolução de
  // agosto, que marca o começo, e o atendimento de agosto antes dela.
  paginas = new Map<number | undefined, Msg[]>([
    [
      undefined,
      [
        cliente(101, "quero reservar uma sala"),
        pessoa(102, "Regis Costa", "Oi, aqui é o Regis. Qual dia?"),
        atividade(103, "Conversa foi marcada como resolvida por Regis Costa", RESOLVIDA_EM + 1),
      ],
    ],
    [
      101,
      [
        cliente(90, "assunto de agosto", RESOLVIDA_EM - 3_000_000),
        pessoa(91, "Socorro", "resposta de agosto", { created_at: RESOLVIDA_EM - 2_999_500 }),
        atividade(92, "Conversa foi marcada como resolvida por Socorro", RESOLVIDA_EM - 2_999_000),
      ],
    ],
  ]);
  pedidosDePagina = [];
  leituraFalha = null;
  desfechos = [];
  toolCallCount = 0;
  entrada = null;
  execucao = { resultado: { runId: "run-1", toolCalls: [{}, {}], iteracoes: 3 } };
});

describe("antes de gastar modelo", () => {
  it("gatilho desligado não roda o agente", async () => {
    gatilho!.enabled = false;
    await processarConversaEncerrada(job());

    expect(entrada).toBeNull();
    expect(desfechos[0]?.resultado).toBe("ignorado");
  });

  it("agente desligado ou arquivado não roda", async () => {
    gatilho!.agent = { active: true, archivedAt: new Date() };
    await processarConversaEncerrada(job());
    expect(entrada).toBeNull();
  });

  it("sem token de leitura falha sem tentar de novo — é configuração", async () => {
    leituraConfigurada = false;
    await expect(processarConversaEncerrada(job())).resolves.toBeUndefined();

    expect(entrada).toBeNull();
    expect(desfechos[0]).toMatchObject({ resultado: "falhou" });
    expect(desfechos[0].detalhe).toContain("token de leitura");
  });

  it("⚠ atendimento sem resposta de pessoa não chama o modelo", async () => {
    paginas.set(undefined, [
      cliente(101, "preciso de ajuda"),
      pessoa(102, "Regis Costa", "anotado", { private: true }),
      atividade(103, "Conversa foi marcada como resolvida por Regis Costa", RESOLVIDA_EM + 1),
    ]);
    paginas.set(101, []);

    await processarConversaEncerrada(job());

    expect(entrada).toBeNull();
    expect(desfechos[0]).toEqual({
      resultado: "ignorado",
      detalhe: "nenhuma pessoa da equipe respondeu ao cliente neste atendimento",
    });
  });

  it("mensagem só da conta de automação também não conta", async () => {
    paginas.set(undefined, [
      cliente(101, "5"),
      pessoa(102, "Basílio Oliveira", "Muito obrigado pela sua avaliação!"),
    ]);
    paginas.set(101, []);

    await processarConversaEncerrada(job());
    expect(entrada).toBeNull();
  });

  it("sem a exigência de pessoa, roda mesmo assim", async () => {
    gatilho!.exigeAtendimentoHumano = false;
    paginas.set(undefined, [cliente(101, "oi")]);
    paginas.set(101, []);

    await processarConversaEncerrada(job());
    expect(entrada).not.toBeNull();
  });

  it("falha ao ler a conversa relança — nada foi feito ainda", async () => {
    leituraFalha = new Error("Chatwoot respondeu 502");

    await expect(processarConversaEncerrada(job())).rejects.toThrow("502");
    expect(desfechos[0]?.resultado).toBe("falhou");
    expect(entrada).toBeNull();
  });
});

describe("execução", () => {
  it("lê para trás até a resolução anterior e entrega só o atendimento de hoje", async () => {
    await processarConversaEncerrada(job());

    expect(pedidosDePagina).toEqual([undefined, 101]);
    expect(entrada?.source).toBe("CONVERSA_ENCERRADA");
    expect(entrada?.conversationId).toBe("conversa-local");
    expect(entrada?.chatwootConversationId).toBe(13498);

    const mensagem = entrada?.mensagem ?? "";
    expect(mensagem).toContain("https://chatwoot.test/app/accounts/1/conversations/13498");
    expect(mensagem).toContain("Quem da equipe respondeu ao cliente: Regis Costa");
    expect(mensagem).toContain("Atendente (Regis Costa): Oi, aqui é o Regis");
    expect(mensagem).not.toContain("assunto de agosto");
    expect(mensagem).not.toContain("Socorro");
    expect(mensagem).not.toContain("não foi lido");

    expect(desfechos[0]?.resultado).toBe("executado");
    expect(desfechos[0]?.detalhe).toContain("run-1");
  });

  it("primeiro atendimento da conversa: para quando as páginas acabam", async () => {
    paginas.set(101, []);

    await processarConversaEncerrada(job());

    expect(pedidosDePagina).toEqual([undefined, 101]);
    expect(entrada?.mensagem).not.toContain("não foi lido");
  });

  it("parada pedida no painel encerra sem tentar de novo", async () => {
    execucao = { erro: new ExecucaoInterrompida("run-1", "Diego") };

    await expect(processarConversaEncerrada(job())).resolves.toBeUndefined();
    expect(desfechos[0]?.resultado).toBe("interrompido");
  });

  it("falha antes de qualquer tool relança, para o BullMQ tentar de novo", async () => {
    execucao = { erro: new Error("OpenRouter fora do ar") };

    await expect(processarConversaEncerrada(job())).rejects.toThrow("OpenRouter");
    expect(desfechos[0]?.resultado).toBe("falhou");
  });

  it("⚠ falha depois de tool NÃO relança — a nota pode já estar no CRM", async () => {
    execucao = {
      erro: Object.assign(new Error("banco caiu"), { runId: "run-2" }),
    };
    toolCallCount = 2;

    await expect(processarConversaEncerrada(job())).resolves.toBeUndefined();
    expect(desfechos[0]?.resultado).toBe("falhou");
  });
});
