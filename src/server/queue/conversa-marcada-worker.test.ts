import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { JobConversaMarcada } from "./conversa-marcada";
import type { EntradaExecucao } from "@/server/agents/runner";
import { ExecucaoInterrompida } from "@/server/agents/cancelamento";

/**
 * O que este worker não pode errar: criar task em dobro, registrar sem saber
 * quem atendeu, e deixar o checkbox marcado ou a equipe sem saber o que houve.
 */

type Msg = {
  id: number;
  content: string | null;
  message_type: number;
  private?: boolean;
  created_at: number;
  sender?: { type?: string; name?: string } | null;
};

/** 15/09/2026 13:28 em São Paulo. */
const MARCADO_EM = 1_789_489_687.25;

let gatilho: {
  id: string;
  agentId: string;
  enabled: boolean;
  atributos: string[];
  exigeAtendimentoHumano: boolean;
  contasDeAutomacao: string[];
  agent: { name: string; active: boolean; archivedAt: Date | null };
} | null;
let leituraConfigurada: boolean;
let estado: {
  status: string | null;
  assigneeId: number | null;
  assigneeTipo: string | null;
  assigneeNome: string | null;
};
let atributosGravados: { conversa: number; atributos: Record<string, unknown> }[];
let falhaAoDesmarcar: Error | null;
let paginas: Map<number | undefined, Msg[]>;
let porta: string | null;
let notas: { portaId: string; conversa: number; texto: string; privado?: boolean }[];
let chamadasDeCriar: { output: unknown; createdAt: Date }[];
let consultaDeRegistro: { where?: Record<string, unknown> } | null;
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
    conversation: {
      findUnique: async () => ({ id: "conversa-local", portaAgentId: porta }),
    },
    toolCall: {
      count: async () => toolCallCount,
      findMany: async (args: { where?: Record<string, unknown> }) => {
        consultaDeRegistro = args;
        return chamadasDeCriar;
      },
    },
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
            definirAtributosDaConversa: async (
              conversa: number,
              atributos: Record<string, unknown>,
            ) => {
              if (falhaAoDesmarcar) throw falhaAoDesmarcar;
              atributosGravados.push({ conversa, atributos });
            },
            obterConversa: async () => estado,
            listarMensagensAntes: async (_conversa: number, antesDe?: number) =>
              paginas.get(antesDe) ?? [],
          },
        }
      : null,
  clienteDoAgente: async (portaId: string) => ({
    enviarMensagem: async (
      conversa: number,
      texto: string,
      opcoes?: { privado?: boolean },
    ) => {
      notas.push({ portaId, conversa, texto, privado: opcoes?.privado });
    },
  }),
}));

const { processarConversaMarcada } = await import("./conversa-marcada-worker");

const job = () =>
  ({
    data: {
      gatilhoId: "gatilho-1",
      agentId: "crm-comercial",
      webhookEventId: "entrega-1",
      chatwootConversationId: 12345,
      inboxId: 29,
      atributo: "passar_para_crm",
      marcadoEm: MARCADO_EM,
      contatoNome: "Maria",
      telefone: "+558487654321",
    },
  }) as Job<JobConversaMarcada>;

const cliente = (id: number, texto: string, created_at = MARCADO_EM - 900): Msg => ({
  id,
  content: texto,
  message_type: 0,
  created_at,
  sender: { type: "contact", name: "Maria" },
});
const pessoa = (id: number, nome: string, texto: string, created_at = MARCADO_EM - 600): Msg => ({
  id,
  content: texto,
  message_type: 1,
  created_at,
  sender: { type: "user", name: nome },
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
    agentId: "crm-comercial",
    enabled: true,
    atributos: ["passar_para_crm"],
    exigeAtendimentoHumano: false,
    contasDeAutomacao: [],
    agent: { name: "Agente CRM Comercial", active: true, archivedAt: null },
  };
  leituraConfigurada = true;
  estado = { status: "open", assigneeId: 21, assigneeTipo: "User", assigneeNome: "Regis Costa" };
  atributosGravados = [];
  falhaAoDesmarcar = null;
  // Página mais nova: o atendimento de hoje. Página anterior: a resolução de
  // agosto, que marca o começo, e o atendimento de agosto antes dela.
  paginas = new Map<number | undefined, Msg[]>([
    [
      undefined,
      [
        cliente(101, "quero reservar o auditório"),
        pessoa(102, "Regis Costa", "Oi, aqui é o Regis. Qual dia?"),
        atividade(103, "Sistema de Automação adicionou crm_clickup", MARCADO_EM),
      ],
    ],
    [
      101,
      [
        cliente(90, "assunto de agosto", MARCADO_EM - 3_000_000),
        atividade(92, "Conversa foi marcada como resolvida por Socorro", MARCADO_EM - 2_999_000),
      ],
    ],
  ]);
  porta = "porta";
  notas = [];
  chamadasDeCriar = [];
  consultaDeRegistro = null;
  desfechos = [];
  toolCallCount = 0;
  entrada = null;
  execucao = { resultado: { runId: "run-1", toolCalls: [{}, {}], iteracoes: 3 } };
});

describe("antes de gastar modelo", () => {
  it("gatilho desligado não toca no checkbox nem roda", async () => {
    gatilho!.enabled = false;
    await processarConversaMarcada(job());

    expect(atributosGravados).toEqual([]);
    expect(entrada).toBeNull();
    expect(desfechos[0]?.resultado).toBe("ignorado");
  });

  it("checkbox tirado da configuração depois da marcação também não roda", async () => {
    gatilho!.atributos = ["atendimento"];
    await processarConversaMarcada(job());

    expect(atributosGravados).toEqual([]);
    expect(entrada).toBeNull();
  });

  it("sem token de leitura falha sem tentar de novo — é configuração", async () => {
    leituraConfigurada = false;
    await expect(processarConversaMarcada(job())).resolves.toBeUndefined();

    expect(entrada).toBeNull();
    expect(desfechos[0]).toMatchObject({ resultado: "falhou" });
    expect(desfechos[0].detalhe).toContain("token de leitura");
  });

  it("desmarca antes de tudo, só o checkbox que disparou", async () => {
    await processarConversaMarcada(job());
    expect(atributosGravados).toEqual([
      { conversa: 12345, atributos: { passar_para_crm: null } },
    ]);
  });

  it("⚠ conversa sem pessoa responsável: não roda e deixa nota", async () => {
    estado = { status: "open", assigneeId: null, assigneeTipo: null, assigneeNome: null };
    await processarConversaMarcada(job());

    expect(entrada).toBeNull();
    expect(notas).toHaveLength(1);
    expect(notas[0]).toMatchObject({ portaId: "porta", conversa: 12345, privado: true });
    expect(notas[0].texto).toContain("Atribua a conversa");
    expect(desfechos[0].resultado).toBe("ignorado");
    expect(desfechos[0].detalhe).toContain("sem pessoa responsável");
    expect(desfechos[0].detalhe).toContain("nota interna deixada");
  });

  it("o nosso robô como dono conta como ninguém", async () => {
    estado = { status: "pending", assigneeId: 4, assigneeTipo: "AgentBot", assigneeNome: "Seahub Coworking" };
    await processarConversaMarcada(job());

    expect(entrada).toBeNull();
    expect(notas[0]?.texto).toContain("Atribua a conversa");
  });

  it("caixa sem o nosso robô: não há por onde deixar nota, e o detalhe diz isso", async () => {
    estado = { status: "open", assigneeId: null, assigneeTipo: null, assigneeNome: null };
    porta = null;
    await processarConversaMarcada(job());

    expect(notas).toEqual([]);
    expect(desfechos[0].detalhe).toContain("sem robô nesta caixa");
  });

  it("⚠ task já criada por este agente nesta conversa: não cria outra", async () => {
    // O caso real da 10912: o CRM criou a task às 09:19 e o checkbox das 13:28
    // tentou outra.
    chamadasDeCriar = [
      {
        output: { criada: true, url: "https://app.clickup.com/t/abc", nome: "CW — Maria" },
        createdAt: new Date("2026-09-15T12:19:00Z"),
      },
    ];
    await processarConversaMarcada(job());

    expect(entrada).toBeNull();
    expect(notas[0].texto).toContain("https://app.clickup.com/t/abc");
    expect(desfechos[0].resultado).toBe("ignorado");
    expect(desfechos[0].detalhe).toContain("task já registrada");

    // A conferência é deste agente, nesta conversa, e só de criação.
    expect(consultaDeRegistro?.where).toMatchObject({
      toolName: "clickup_criar_tarefa",
      isError: false,
      run: { agentId: "crm-comercial", conversationId: "conversa-local" },
    });
  });

  it("tentativa que não criou nada não conta como registro", async () => {
    chamadasDeCriar = [
      { output: "Não consegui identificar o responsável.", createdAt: new Date() },
      { output: { criada: false }, createdAt: new Date() },
    ];
    await processarConversaMarcada(job());
    expect(entrada).not.toBeNull();
  });
});

describe("execução", () => {
  it("roda como conversa marcada, pela porta, com o dono e o atendimento de hoje", async () => {
    await processarConversaMarcada(job());

    expect(entrada?.source).toBe("CONVERSA_MARCADA");
    expect(entrada?.agentId).toBe("crm-comercial");
    expect(entrada?.conversationId).toBe("conversa-local");
    expect(entrada?.chatwootConversationId).toBe(12345);
    // Os agentes internos não têm bot: nota e dados do contato saem pela porta.
    expect(entrada?.canalAgentId).toBe("porta");

    const mensagem = entrada?.mensagem ?? "";
    expect(mensagem).toContain("Checkbox marcado: passar_para_crm");
    expect(mensagem).toContain("Dono da conversa no Chatwoot: Regis Costa");
    expect(mensagem).toContain("https://chatwoot.test/app/accounts/1/conversations/12345");
    expect(mensagem).toContain("Atendente (Regis Costa): Oi, aqui é o Regis");
    expect(mensagem).not.toContain("assunto de agosto");

    expect(desfechos[0]?.resultado).toBe("executado");
    expect(desfechos[0]?.detalhe).toContain("run-1");
  });

  it("conversa já resolvida: o atendimento que terminou nela", async () => {
    estado = { ...estado, status: "resolved" };
    paginas.set(undefined, [
      cliente(101, "quero reservar o auditório", MARCADO_EM - 7_200),
      pessoa(102, "Regis Costa", "reservado!", MARCADO_EM - 7_000),
      atividade(103, "Conversa foi marcada como resolvida por Regis Costa", MARCADO_EM - 3_600),
      atividade(104, "Sistema de Automação adicionou crm_clickup", MARCADO_EM),
    ]);

    await processarConversaMarcada(job());

    expect(entrada?.mensagem).toContain("reservado!");
    expect(entrada?.mensagem).not.toContain("assunto de agosto");
  });

  it("falha ao desmarcar não impede o registro, e fica escrita", async () => {
    falhaAoDesmarcar = new Error("Chatwoot respondeu 422");
    await processarConversaMarcada(job());

    expect(entrada).not.toBeNull();
    expect(desfechos[0].resultado).toBe("executado");
    expect(desfechos[0].detalhe).toContain("checkbox não desmarcado");
  });

  it("parada pedida no painel encerra sem tentar de novo", async () => {
    execucao = { erro: new ExecucaoInterrompida("run-1", "Diego") };

    await expect(processarConversaMarcada(job())).resolves.toBeUndefined();
    expect(desfechos[0]?.resultado).toBe("interrompido");
  });

  it("falha antes de qualquer tool relança, para o BullMQ tentar de novo", async () => {
    execucao = { erro: new Error("OpenRouter fora do ar") };

    await expect(processarConversaMarcada(job())).rejects.toThrow("OpenRouter");
    expect(desfechos[0]?.resultado).toBe("falhou");
  });

  it("⚠ falha depois de tool NÃO relança — a task pode já estar no CRM", async () => {
    execucao = { erro: Object.assign(new Error("banco caiu"), { runId: "run-2" }) };
    toolCallCount = 2;

    await expect(processarConversaMarcada(job())).resolves.toBeUndefined();
    expect(desfechos[0]?.resultado).toBe("falhou");
  });
});
