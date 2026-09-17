import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { EntradaExecucao } from "@/server/agents/runner";
import { ExecucaoInterrompida } from "@/server/agents/cancelamento";
import type { JobConversaParada, JobVarredura } from "./conversa-parada";

/**
 * O que este worker não pode errar: gastar modelo numa conversa que já andou,
 * escrever num atendimento que virou de dono, e dizer "executado" quando o
 * agente não deixou nota nenhuma — o defeito medido no fluxo do n8n em
 * 17/09/2026, em que 2 de 25 análises nunca chegaram à conversa.
 */

type Msg = {
  id: number;
  content: string | null;
  message_type: number;
  private?: boolean;
  created_at: number;
  sender?: { type?: string; name?: string } | null;
};

/** 17/09/2026 10:00 em São Paulo, em segundos. */
const AGORA = 1_789_650_000;
const HORA = 3600;

let gatilho: {
  id: string;
  agentId: string;
  evento: string;
  enabled: boolean;
  horasParadas: number;
  tetoPorRodada: number;
  contasDeAutomacao: string[];
  agent: {
    name: string;
    active: boolean;
    archivedAt: Date | null;
    inboxMode?: string;
    inboxIds?: number[];
  };
} | null;
let leituraConfigurada: boolean;
let estado: {
  status: string | null;
  assigneeId: number | null;
  assigneeTipo: string | null;
  assigneeNome: string | null;
};
let paginas: Map<number | undefined, Msg[]>;
let porta: string | null;
let desfechos: { resultado: string; detalhe: string }[];
let resumos: { resultado: string; detalhe: string }[];
let toolCallCount: number;
let entrada: EntradaExecucao | null;
let execucao: {
  resultado?: { runId: string; toolCalls: { nome: string; isError: boolean }[]; iteracoes: number };
  erro?: Error & { runId?: string };
};
let entregasCriadas: { externalId: string }[];
let conflitoDeUnique: boolean;
let paginasDeConversas: Map<number, unknown[]>;
let enfileirados: JobConversaParada[];

vi.mock("@/lib/db", () => ({
  db: {
    gatilhoDeConversa: {
      findUnique: async () => gatilho,
      update: async ({ data }: { data: { ultimoResultado: string; ultimoDetalhe: string } }) => {
        resumos.push({ resultado: data.ultimoResultado, detalhe: data.ultimoDetalhe });
        return {};
      },
    },
    webhookEvent: {
      create: async ({ data }: { data: { externalId: string } }) => {
        if (conflitoDeUnique) throw Object.assign(new Error("unique"), { code: "P2002" });
        entregasCriadas.push({ externalId: data.externalId });
        return { id: `entrega-${entregasCriadas.length}` };
      },
      update: async ({ data }: { data: { resultado: string; detalhe: string } }) => {
        desfechos.push({ resultado: data.resultado, detalhe: data.detalhe });
      },
    },
    conversation: {
      findUnique: async () => ({ id: "conversa-local", portaAgentId: porta }),
      findFirst: async () => (porta ? { portaAgentId: porta } : null),
    },
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

vi.mock("@/server/queue/conversa-parada", async (original) => ({
  ...(await original<typeof import("./conversa-parada")>()),
  agendarConversaParada: async (dados: JobConversaParada) => {
    enfileirados.push(dados);
  },
}));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteDeLeitura: async () =>
    leituraConfigurada
      ? {
          config: { baseUrl: "https://chatwoot.test", accountId: 1 },
          cliente: {
            obterConversa: async () => estado,
            listarMensagensAntes: async (_conversa: number, antesDe?: number) =>
              paginas.get(antesDe) ?? [],
            listarConversas: async ({ pagina }: { pagina?: number }) => ({
              conversas: paginasDeConversas.get(pagina ?? 1) ?? [],
              total: 107,
            }),
          },
        }
      : null,
  clienteDoAgente: async () => ({ enviarMensagem: async () => {} }),
}));

const { processarConversaParada, processarVarredura } = await import(
  "./conversa-parada-worker"
);

const cliente = (id: number, texto: string, created_at = AGORA - 48 * HORA): Msg => ({
  id,
  content: texto,
  message_type: 0,
  created_at,
  sender: { type: "contact", name: "Maria" },
});
const pessoa = (id: number, texto: string, created_at = AGORA - 48 * HORA): Msg => ({
  id,
  content: texto,
  message_type: 1,
  created_at,
  sender: { type: "user", name: "Arthur George" },
});

const job = () =>
  ({
    data: {
      gatilhoId: "gatilho-1",
      agentId: "assistente-vendedor",
      webhookEventId: "entrega-1",
      chatwootConversationId: 13993,
      inboxId: 29,
      contatoNome: "Maria",
      telefone: "+558487654321",
      dono: "Arthur George",
      ultimaMensagemEm: AGORA - 48 * HORA,
      ultimoFalante: "cliente" as const,
    },
  }) as Job<JobConversaParada>;

beforeEach(() => {
  gatilho = {
    id: "gatilho-1",
    agentId: "assistente-vendedor",
    evento: "SEM_RESPOSTA",
    enabled: true,
    horasParadas: 24,
    tetoPorRodada: 60,
    contasDeAutomacao: [],
    agent: {
      name: "Assistente Vendedor",
      active: true,
      archivedAt: null,
      inboxMode: "specific",
      inboxIds: [29],
    },
  };
  leituraConfigurada = true;
  estado = {
    status: "open",
    assigneeId: 21,
    assigneeTipo: "User",
    assigneeNome: "Arthur George",
  };
  paginas = new Map<number | undefined, Msg[]>([
    [
      undefined,
      [
        cliente(101, "quero uma sala privativa para duas pessoas"),
        pessoa(102, "temos sim, na unidade Ayrton Senna"),
      ],
    ],
    [101, []],
  ]);
  porta = "porta-do-bot";
  desfechos = [];
  resumos = [];
  toolCallCount = 0;
  entrada = null;
  execucao = {
    resultado: {
      runId: "run-1",
      toolCalls: [{ nome: "registrar_nota_interna", isError: false }],
      iteracoes: 2,
    },
  };
  entregasCriadas = [];
  conflitoDeUnique = false;
  paginasDeConversas = new Map();
  enfileirados = [];
});

describe("a análise de uma conversa parada", () => {
  it("executa e diz na entrega que a nota foi deixada", async () => {
    await processarConversaParada(job());

    expect(entrada?.source).toBe("CONVERSA_PARADA");
    expect(entrada?.chatwootConversationId).toBe(13993);
    expect(desfechos).toEqual([
      expect.objectContaining({ resultado: "executado" }),
    ]);
    expect(desfechos[0].detalhe).toContain("nota interna deixada");
  });

  it("⚠ turno que não gravou nota NÃO se anuncia como se tivesse gravado", async () => {
    // O defeito medido no n8n: o modelo escreve a análise como resposta, não
    // chama a ferramenta, e a execução fica verde. Duas de 25 em 17/09/2026.
    execucao.resultado = { runId: "run-2", toolCalls: [], iteracoes: 1 };

    await processarConversaParada(job());

    expect(desfechos[0].resultado).toBe("executado");
    expect(desfechos[0].detalhe).toContain("sem nota");
  });

  it("nota que falhou não conta como nota deixada", async () => {
    execucao.resultado = {
      runId: "run-3",
      toolCalls: [{ nome: "registrar_nota_interna", isError: true }],
      iteracoes: 2,
    };

    await processarConversaParada(job());

    expect(desfechos[0].detalhe).toContain("sem nota");
  });

  it("⚠ reconfere AO VIVO: alguém respondeu entre a varredura e agora", async () => {
    paginas.set(undefined, [
      cliente(101, "quero uma sala privativa para duas pessoas"),
      pessoa(102, "temos sim, na unidade Ayrton Senna"),
      pessoa(103, "consegui o desconto que você pediu!", AGORA - 120),
    ]);

    await processarConversaParada(job());

    expect(entrada).toBeNull();
    expect(desfechos[0].resultado).toBe("ignorado");
    expect(desfechos[0].detalhe).toContain("mudou antes da análise");
  });

  it("⚠ a conversa mudou de mãos e está com o robô: não escreve", async () => {
    estado = { status: "open", assigneeId: 4, assigneeTipo: "AgentBot", assigneeNome: "Seahub" };

    await processarConversaParada(job());

    expect(entrada).toBeNull();
    expect(desfechos[0].resultado).toBe("ignorado");
  });

  it("resolvida no meio do caminho: não escreve", async () => {
    estado = { ...estado, status: "resolved" };

    await processarConversaParada(job());

    expect(entrada).toBeNull();
    expect(desfechos[0].resultado).toBe("ignorado");
  });

  it("gatilho desligado entre a varredura e a análise não roda", async () => {
    gatilho = { ...gatilho!, enabled: false };

    await processarConversaParada(job());

    expect(entrada).toBeNull();
    expect(desfechos[0].detalhe).toContain("desligado");
  });

  it("⚠ sem robô na caixa não há por onde escrever, e a entrega diz isso", async () => {
    porta = null;

    await processarConversaParada(job());

    expect(entrada).toBeNull();
    expect(desfechos[0].resultado).toBe("ignorado");
    expect(desfechos[0].detalhe).toContain("nenhum agente com bot");
  });

  it("a mensagem do turno leva a conversa cercada e quem é o dono", async () => {
    await processarConversaParada(job());

    expect(entrada?.mensagem).toContain("[Conversa parada");
    expect(entrada?.mensagem).toContain("Arthur George");
    expect(entrada?.mensagem).toContain("[transcrição do atendimento]");
    expect(entrada?.mensagem).toContain("[fim da transcrição]");
  });

  it("parada pelo painel não vira erro nem nova tentativa", async () => {
    execucao = { erro: new ExecucaoInterrompida("run-x", "Basílio") };

    await expect(processarConversaParada(job())).resolves.toBeUndefined();
    expect(desfechos[0].resultado).toBe("interrompido");
  });

  it("⚠ falha DEPOIS de uma tool não é relançada: a nota pode já estar lá", async () => {
    execucao = { erro: Object.assign(new Error("provedor caiu"), { runId: "run-4" }) };
    toolCallCount = 1;

    await expect(processarConversaParada(job())).resolves.toBeUndefined();
    expect(desfechos[0].resultado).toBe("falhou");
  });

  it("falha ANTES de qualquer tool é relançada para o BullMQ tentar de novo", async () => {
    execucao = { erro: Object.assign(new Error("rede"), { runId: "run-5" }) };
    toolCallCount = 0;

    await expect(processarConversaParada(job())).rejects.toThrow("rede");
  });
});

describe("a varredura do relógio", () => {
  const conversaListada = (id: number, criadaEm: number, privada = false) => ({
    id,
    inboxId: 29,
    status: "open",
    assigneeId: 21,
    assigneeTipo: "User",
    assigneeNome: "Arthur George",
    contatoNome: "Maria",
    telefone: "+558487654321",
    ultimaMensagem: { id: 100 + id, criadaEm, privada },
  });

  it("⚠ pagina até o fim: era o defeito que deixava 82 de 107 sem análise", async () => {
    // Página cheia (25) obriga a pedir a seguinte; a incompleta encerra.
    paginasDeConversas.set(
      1,
      Array.from({ length: 25 }, (_, i) => conversaListada(200 + i, AGORA - 2 * HORA)),
    );
    paginasDeConversas.set(2, [conversaListada(300, AGORA - 48 * HORA)]);

    await processarVarredura({ data: { gatilhoId: "gatilho-1" } } as Job<JobVarredura>);

    expect(resumos[0].resultado).toBe("executado");
    expect(resumos[0].detalhe).toContain("26 conversa(s) abertas");
    // As 25 ativas saem de graça no pré-filtro; só a parada vira execução.
    expect(enfileirados).toHaveLength(1);
    expect(enfileirados[0].chatwootConversationId).toBe(300);
  });

  it("⚠ a chave da entrega é a última mensagem PÚBLICA, não a rodada", async () => {
    paginasDeConversas.set(1, [conversaListada(300, AGORA - 48 * HORA)]);

    await processarVarredura({ data: { gatilhoId: "gatilho-1" } } as Job<JobVarredura>);

    // 102 é a última pública do atendimento montado no beforeEach.
    expect(entregasCriadas[0].externalId).toBe("assistente-vendedor:300:102");
  });

  it("já analisada e sem mensagem nova: não gasta modelo, e o resumo conta", async () => {
    paginasDeConversas.set(1, [conversaListada(300, AGORA - 48 * HORA)]);
    conflitoDeUnique = true;

    await processarVarredura({ data: { gatilhoId: "gatilho-1" } } as Job<JobVarredura>);

    expect(enfileirados).toHaveLength(0);
    expect(resumos[0].detalhe).toContain("1 sem mensagem nova");
  });

  it("⚠ o teto por rodada corta o gasto, e o que sobra fica para amanhã", async () => {
    gatilho = { ...gatilho!, tetoPorRodada: 2 };
    paginasDeConversas.set(
      1,
      Array.from({ length: 10 }, (_, i) => conversaListada(300 + i, AGORA - 48 * HORA)),
    );

    await processarVarredura({ data: { gatilhoId: "gatilho-1" } } as Job<JobVarredura>);

    // O lote é de 5, então ele termina o lote corrente antes de parar.
    expect(enfileirados.length).toBeLessThanOrEqual(5);
    expect(enfileirados.length).toBeGreaterThanOrEqual(2);
  });

  it("gatilho desligado no relógio não varre nada", async () => {
    gatilho = { ...gatilho!, enabled: false };

    await processarVarredura({ data: { gatilhoId: "gatilho-1" } } as Job<JobVarredura>);

    expect(resumos).toHaveLength(0);
    expect(enfileirados).toHaveLength(0);
  });

  it("sem token de leitura, a tela diz o que configurar", async () => {
    leituraConfigurada = false;

    await processarVarredura({ data: { gatilhoId: "gatilho-1" } } as Job<JobVarredura>);

    expect(resumos[0].resultado).toBe("falhou");
    expect(resumos[0].detalhe).toContain("token de leitura");
  });
});
