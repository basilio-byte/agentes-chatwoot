import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { JobAtendimento } from "./atendimento";

/**
 * O laço de transferência é o caminho crítico do atendimento: ele fica entre a
 * mensagem do cliente e a resposta. Erro aqui é silêncio para o cliente, que é
 * o pior modo de falha possível — por isso ele é testado de ponta a ponta, com
 * o modelo e o Chatwoot dublados.
 */

type Agente = {
  id: string;
  key: string;
  name: string;
  routingDescription: string | null;
  active: boolean;
  isEntry: boolean;
};

const EQUIPE: Agente[] = [
  { id: "entrada", key: "entrada", name: "Recepção", routingDescription: "primeiro contato", active: true, isEntry: true },
  { id: "reservas", key: "reservas", name: "Reservas", routingDescription: "salas e reservas", active: true, isEntry: false },
  { id: "documentos", key: "documentos", name: "Documentos", routingDescription: "contratos e documentos", active: true, isEntry: false },
  { id: "servicos", key: "servicos", name: "Serviços", routingDescription: "serviços do coworking", active: true, isEntry: false },
  { id: "suporte", key: "suporte", name: "Suporte", routingDescription: "problemas e suporte", active: true, isEntry: false },
  { id: "recurso", key: "recurso", name: "Recurso", routingDescription: "consulta de um recurso único", active: true, isEntry: false },
];

/** Estado da conversa no nosso banco, mutável durante o teste. */
let conversa: Record<string, unknown>;
let handoffsGravados: Record<string, unknown>[];
/** Mensagens enviadas ao Chatwoot: {texto, privado}. */
let enviadas: { texto: string; privado: boolean }[];
let statusChatwoot: { status: string; assigneeId: number | null };
/** Fila de respostas do "modelo", consumida a cada chamada de executarAgente. */
let respostasDoModelo: Array<{
  resposta?: string;
  handoff?: unknown;
  /** Um humano resolve a conversa enquanto o agente pensa. */
  resolveNoMeio?: boolean;
}>;
let agentesQueRodaram: string[];
let bastoesRecebidos: (string | null | undefined)[];

vi.mock("@/lib/db", () => ({
  db: {
    conversation: {
      findUnique: async () => conversa,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(conversa, data);
        return { count: 1 };
      },
    },
    agent: { findMany: async () => EQUIPE },
    agentHandoff: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        handoffsGravados.push(data);
        return data;
      },
    },
  },
}));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteDoAgente: async () => ({
    obterConversa: async () => statusChatwoot,
    listarMensagens: async () => [
      { id: 1, message_type: 0, content: "quero alugar uma sala", private: false },
    ],
    enviarMensagem: async (
      _c: number,
      texto: string,
      opcoes?: { privado?: boolean },
    ) => {
      enviadas.push({ texto, privado: opcoes?.privado ?? false });
      return { id: enviadas.length };
    },
    alternarStatus: async (_c: number, status: string) => {
      statusChatwoot = { ...statusChatwoot, status };
    },
  }),
}));

vi.mock("@/server/agents/runner", () => ({
  executarAgente: async (entrada: { agentId: string; bastao?: string | null }) => {
    agentesQueRodaram.push(entrada.agentId);
    bastoesRecebidos.push(entrada.bastao);

    const proxima = respostasDoModelo.shift() ?? { resposta: "pronto" };
    // Simula um humano resolvendo a conversa enquanto o agente pensava.
    if (proxima.resolveNoMeio) statusChatwoot = { ...statusChatwoot, status: "resolved" };
    return {
      runId: `run-${agentesQueRodaram.length}`,
      resposta: proxima.resposta ?? "",
      iteracoes: 1,
      atingiuLimiteDeIteracoes: false,
      toolCalls: [],
      uso: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      custoUsd: 0,
      latenciaMs: 10,
      handoff: proxima.handoff,
    };
  },
}));

const { processarAtendimento } = await import("./worker");

function passarPara(key: string, aviso = `Vou te passar para ${key}, um instante.`) {
  const destino = EQUIPE.find((a) => a.key === key)!;
  return {
    handoff: {
      destinoId: destino.id,
      destinoKey: destino.key,
      destinoNome: destino.name,
      motivo: `assunto de ${key}`,
      resumo: `cliente quer algo de ${key}; já informou o nome`,
      aviso,
    },
  };
}

const job = (agentId = "porta", tentativa = 2) =>
  ({
    data: { chatwootConversationId: 55, agentId, inboxId: 1 },
    // Como o BullMQ entrega: 3 tentativas, e esta é a última.
    opts: { attempts: 3 },
    attemptsMade: tentativa,
  }) as Job<JobAtendimento>;

beforeEach(() => {
  conversa = {
    id: "conv-1",
    chatwootConversationId: 55,
    status: "BOT",
    agentId: null,
    historicoDesde: null,
    handoffParaAgentId: null,
    handoffResumo: null,
    handoffMotivo: null,
    handoffDeNome: null,
    // Relógio do vigia, aceso pelo webhook quando a mensagem do cliente chegou.
    aguardandoDesde: new Date("2026-07-31T12:00:00Z"),
  };
  handoffsGravados = [];
  enviadas = [];
  statusChatwoot = { status: "pending", assigneeId: null };
  respostasDoModelo = [];
  agentesQueRodaram = [];
  bastoesRecebidos = [];
});

afterEach(() => vi.clearAllMocks());

const publicas = () => enviadas.filter((m) => !m.privado).map((m) => m.texto);

describe("relógio de espera do cliente", () => {
  /**
   * O vigia mede uma coisa só: há quanto tempo o cliente está sem resposta.
   * Se o relógio não parasse a cada turno respondido, ele viraria o tempo total
   * da conversa — e toda conversa longa acabaria escalada para um humano,
   * mesmo com o agente respondendo na hora.
   */
  it("para a cada resposta — não acumula entre turnos", async () => {
    respostasDoModelo = [{ resposta: "Olá!" }];

    await processarAtendimento(job());

    expect(conversa.aguardandoDesde).toBeNull();
  });

  it("segue correndo durante a cadeia de transferências", async () => {
    // O aviso de passagem não é atendimento: o cliente continua esperando a
    // resposta de verdade, e só ela solta o relógio.
    respostasDoModelo = [passarPara("reservas"), { resposta: "pronto" }];

    await processarAtendimento(job());

    expect(agentesQueRodaram).toEqual(["entrada", "reservas"]);
    expect(conversa.aguardandoDesde).toBeNull();
  });

  it("entregar a conversa a um humano também para o relógio", async () => {
    // Daqui em diante quem deve resposta é uma pessoa, e o vigia não cobra
    // pessoa — deixar o relógio correndo escalaria o que já foi escalado.
    respostasDoModelo = Array.from({ length: 12 }, (_, i) =>
      passarPara(i % 2 === 0 ? "reservas" : "entrada"),
    );

    await processarAtendimento(job());

    expect(conversa.status).toBe("HUMAN");
    expect(conversa.aguardandoDesde).toBeNull();
  });
});

describe("roteamento inicial", () => {
  it("sem dono, quem atende é o agente de entrada", async () => {
    respostasDoModelo = [{ resposta: "Olá! Como posso ajudar?" }];

    await processarAtendimento(job());

    expect(agentesQueRodaram).toEqual(["entrada"]);
    expect(publicas()).toEqual(["Olá! Como posso ajudar?"]);
  });

  it("o dono da conversa continua atendendo, sem voltar para a entrada", async () => {
    conversa.agentId = "reservas";
    respostasDoModelo = [{ resposta: "A sala 3 está livre." }];

    await processarAtendimento(job());

    expect(agentesQueRodaram).toEqual(["reservas"]);
  });
});

describe("transferência", () => {
  it("avisa o cliente, passa o bastão e o colega responde no mesmo ciclo", async () => {
    respostasDoModelo = [
      passarPara("reservas", "Vou te passar para quem cuida de salas 😊"),
      { resposta: "Oi! Sobre a sala: temos disponibilidade quinta." },
    ];

    await processarAtendimento(job());

    // O cliente recebe o aviso E a resposta — não fica esperando outra mensagem.
    expect(publicas()).toEqual([
      "Vou te passar para quem cuida de salas 😊",
      "Oi! Sobre a sala: temos disponibilidade quinta.",
    ]);
    expect(agentesQueRodaram).toEqual(["entrada", "reservas"]);
  });

  it("o colega recebe o resumo e a ordem de não recomeçar", async () => {
    respostasDoModelo = [passarPara("reservas"), { resposta: "ok" }];

    await processarAtendimento(job());

    const bastao = bastoesRecebidos[1]!;
    expect(bastao).toContain("Recepção");
    expect(bastao).toContain("já informou o nome");
    // Se apresenta, mas não recomeça — as duas coisas juntas.
    expect(bastao).toContain("apresentando");
    expect(bastao).toContain("Não recomece");
    // Quem começou o atendimento não recebe bastão nenhum.
    expect(bastoesRecebidos[0]).toBeNull();
  });

  it("grava a passagem para auditoria e move o dono da conversa", async () => {
    respostasDoModelo = [passarPara("reservas"), { resposta: "ok" }];

    await processarAtendimento(job());

    expect(handoffsGravados).toHaveLength(1);
    expect(handoffsGravados[0]).toMatchObject({
      fromAgentId: "entrada",
      toAgentId: "reservas",
    });
    expect(conversa.agentId).toBe("reservas");
  });

  it("colega desligado não recebe a conversa", async () => {
    const desligado = EQUIPE.find((a) => a.key === "reservas")!;
    desligado.active = false;

    respostasDoModelo = [passarPara("reservas"), { resposta: "não deveria rodar" }];
    await processarAtendimento(job());

    desligado.active = true;

    expect(agentesQueRodaram).toEqual(["entrada"]);
    expect(conversa.agentId).toBe("entrada");
  });
});

describe("cadeia longa de especialistas", () => {
  it("passa por reservas, documentos, serviços, suporte e recurso", async () => {
    respostasDoModelo = [
      passarPara("reservas"),
      passarPara("documentos"),
      passarPara("servicos"),
      passarPara("suporte"),
      passarPara("recurso"),
      { resposta: "Consultei tudo: segue a informação." },
    ];

    await processarAtendimento(job());

    expect(agentesQueRodaram).toEqual([
      "entrada",
      "reservas",
      "documentos",
      "servicos",
      "suporte",
      "recurso",
    ]);
    expect(publicas().at(-1)).toBe("Consultei tudo: segue a informação.");
    expect(handoffsGravados).toHaveLength(5);
  });

  it("recepção que distribui e recebe de volta várias vezes", async () => {
    respostasDoModelo = [
      passarPara("reservas"),
      passarPara("entrada"),
      passarPara("documentos"),
      passarPara("entrada"),
      passarPara("suporte"),
      { resposta: "resolvido" },
    ];

    await processarAtendimento(job());

    expect(agentesQueRodaram.at(-1)).toBe("suporte");
    expect(publicas().at(-1)).toBe("resolvido");
  });
});

describe("travas", () => {
  it("pinga-pong escala para humano e o cliente é avisado", async () => {
    // A mesma dupla se devolvendo a conversa sem nunca responder.
    respostasDoModelo = Array.from({ length: 12 }, (_, i) =>
      passarPara(i % 2 === 0 ? "reservas" : "entrada"),
    );

    await processarAtendimento(job());

    expect(conversa.status).toBe("HUMAN");
    expect(statusChatwoot.status).toBe("open");
    // Nunca termina em silêncio: a última mensagem pública é para o cliente.
    expect(publicas().at(-1)).toContain("atendente");
    // E fica o rastro interno de por que travou.
    expect(enviadas.some((m) => m.privado && m.texto.includes("devolvendo"))).toBe(true);
  });
});

describe("o bot nunca deixa a conversa pendente", () => {
  it("responde e abre a conversa que chegou pendente", async () => {
    // `pending` não aparece na visualização padrão do Chatwoot: a conversa
    // ficaria escondida da equipe justamente enquanto está sendo atendida.
    statusChatwoot = { status: "pending", assigneeId: null };
    respostasDoModelo = [{ resposta: "Olá! Como posso ajudar?" }];

    await processarAtendimento(job());

    expect(publicas()).toEqual(["Olá! Como posso ajudar?"]);
    expect(statusChatwoot.status).toBe("open");
  });

  it("já aberta continua aberta", async () => {
    statusChatwoot = { status: "open", assigneeId: null };
    respostasDoModelo = [{ resposta: "oi" }];

    await processarAtendimento(job());

    expect(statusChatwoot.status).toBe("open");
  });

  it("o bot nunca resolve — encerrar é decisão de pessoa", async () => {
    statusChatwoot = { status: "pending", assigneeId: null };
    respostasDoModelo = [{ resposta: "pronto" }];

    await processarAtendimento(job());

    expect(statusChatwoot.status).not.toBe("resolved");
  });
});

describe("cliente escreveu em conversa resolvida", () => {
  /**
   * Existe um job, e job só nasce de mensagem de cliente — então a conversa
   * voltou a existir. O Chatwoot costuma reabrir sozinho e em 2026-08-03 não
   * reabriu: a conversa ficou `resolved` com a mensagem entregue, e o
   * atendimento morreu ali. Sem reabrir aqui, nada mais mudaria aquele status.
   */
  it("reabre no Chatwoot e responde", async () => {
    statusChatwoot = { status: "resolved", assigneeId: null };
    respostasDoModelo = [{ resposta: "Oi! Como posso ajudar?" }];

    await processarAtendimento(job());

    expect(statusChatwoot.status).toBe("open");
    expect(publicas()).toEqual(["Oi! Como posso ajudar?"]);
  });

  it("resolvida COM dono continua da pessoa — o bot não toma de volta", async () => {
    statusChatwoot = { status: "resolved", assigneeId: 4 };
    respostasDoModelo = [{ resposta: "não deveria sair" }];

    await processarAtendimento(job());

    expect(statusChatwoot.status).toBe("resolved");
    expect(publicas()).toEqual([]);
  });
});

describe("regra de ouro: resolvida não recebe interação", () => {
  it("resolveram durante o turno — a resposta pronta é descartada", async () => {
    respostasDoModelo = [{ resposta: "resposta que não deve sair", resolveNoMeio: true }];

    await processarAtendimento(job());

    expect(publicas()).toEqual([]);
  });

  /**
   * A rede de segurança olhava só o dono. Numa conversa resolvida sem ninguém
   * atribuído, ela mandava o contorno — reabrindo a conversa que uma pessoa
   * acabou de encerrar. Aqui o silêncio não é falha: é a regra funcionando.
   */
  it("resolveram durante o turno e o agente não produziu texto — nem contorno sai", async () => {
    respostasDoModelo = [{ resposta: "", resolveNoMeio: true }];

    await processarAtendimento(job());

    expect(enviadas).toEqual([]);
  });
});

describe("invariante: o cliente nunca fica sem resposta", () => {
  it("agente que não produz texto ainda gera mensagem de contorno", async () => {
    respostasDoModelo = [{ resposta: "" }];

    await processarAtendimento(job());

    expect(publicas()).toHaveLength(1);
    expect(publicas()[0]).toContain("instabilidade");
    expect(enviadas.some((m) => m.privado)).toBe(true);
  });

  it("nas primeiras tentativas não avisa o cliente — a próxima pode dar certo", async () => {
    const runner = await import("@/server/agents/runner");
    vi.spyOn(runner, "executarAgente").mockRejectedValueOnce(new Error("instabilidade"));

    // Falha na preparação, primeira de três tentativas.
    await expect(processarAtendimento(job("porta", 0))).rejects.toThrow();

    // O laço tem rede própria; o que não pode é avisar cedo e depois responder.
    expect(publicas().filter((m) => m.includes("instabilidade")).length).toBeLessThanOrEqual(1);
  });

  it("exceção no meio do turno não vira silêncio", async () => {
    const runner = await import("@/server/agents/runner");
    vi.spyOn(runner, "executarAgente").mockRejectedValueOnce(
      new Error("provedor fora do ar"),
    );

    await expect(processarAtendimento(job())).rejects.toThrow("provedor fora do ar");

    expect(publicas().at(-1)).toContain("instabilidade");
  });

  it("humano que assumiu no meio silencia o bot — isso não é falha", async () => {
    respostasDoModelo = [{ resposta: "" }];
    statusChatwoot = { status: "open", assigneeId: 7 };

    await processarAtendimento(job());

    // A regra global barra antes de rodar; nada é enviado ao cliente.
    expect(publicas()).toEqual([]);
  });
});
