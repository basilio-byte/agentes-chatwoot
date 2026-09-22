import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEXTOS_PADRAO } from "./config";

/**
 * O que as etapas não podem errar: mandar mensagem duas vezes, falar por cima de
 * uma pessoa, resolver a conversa enquanto o cliente conta o que aconteceu, e
 * mandar a pesquisa fora de ordem.
 */

type Linha = Record<string, unknown> & { id: string; status: string };
type Msg = { id: number; message_type: number; sender?: { type?: string } | null };
type Chamada = { tipo: string; conversa: number; texto?: string; porta: string };

const AGORA = 1_789_500_000_000;
const MIN = 60_000;
const HORA = 60 * MIN;

let linhas: Linha[];
let integracaoNps: { enabled: boolean; config: unknown } | null;
let conversaLocal: { id: string; portaAgentId: string | null } | null;
let vizinha: { portaAgentId: string | null } | null;
let conversasAtualizadas: unknown[];
let recenteDoTelefone: { chatwootConversationId: number } | null;
let conflitoAoEnviar: boolean;
let leituraConfigurada: boolean;
let atributos: { conversa: number; atributos: Record<string, unknown> }[];
let aoVivo: {
  status: string | null;
  assigneeId: number | null;
  assigneeTipo: string | null;
  inboxId: number | null;
  contactId: number | null;
};
let mensagens: Msg[];
let aoListarMensagens: (() => void) | null;
let falharLeitura: Error | null;
let falharEnvioNumero: number | null;
let envios: number;
let chamadas: Chamada[];
let resolvidas: number[];
let agendados: { id: string; espera: number }[];
let gravarArgs: Record<string, unknown> | null;
let semTaskNoCrm: boolean;

function casa(linha: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where).every(([campo, condicao]) => {
    const valor = linha[campo];
    if (condicao instanceof Date) {
      return valor instanceof Date && valor.getTime() === condicao.getTime();
    }
    if (condicao && typeof condicao === "object") {
      const c = condicao as { in?: unknown[]; lte?: Date };
      if (c.in) return c.in.includes(valor);
      if (c.lte) return valor instanceof Date && valor.getTime() <= c.lte.getTime();
      return false;
    }
    return (valor ?? null) === (condicao ?? null);
  });
}

vi.mock("@/lib/db", () => ({
  db: {
    pesquisaNps: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const linha = linhas.find((l) => l.id === where.id);
        return linha ? { ...linha } : null;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        linhas.filter((l) => casa(l, where)).map((l) => ({ id: l.id })),
      findFirst: async () => recenteDoTelefone,
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (conflitoAoEnviar && data.status === "AGUARDANDO") {
          throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        }
        const alvo = linhas.filter((l) => casa(l, where));
        for (const l of alvo) Object.assign(l, data);
        return { count: alvo.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const linha = linhas.find((l) => l.id === where.id)!;
        Object.assign(linha, data);
        return linha;
      },
    },
    integration: { findUnique: async () => integracaoNps },
    conversation: {
      findUnique: async () => conversaLocal,
      findFirst: async () => vizinha,
      updateMany: async (args: unknown) => {
        conversasAtualizadas.push(args);
        return { count: 1 };
      },
    },
  },
}));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteDeLeitura: async () =>
    leituraConfigurada
      ? {
          config: { baseUrl: "https://chatwoot.test", accountId: 1 },
          cliente: {
            definirAtributosDaConversa: async (conversa: number, novos: Record<string, unknown>) => {
              atributos.push({ conversa, atributos: novos });
            },
          },
        }
      : null,
  clienteDoAgente: async (porta: string) => ({
    obterConversa: async () => {
      if (falharLeitura) throw falharLeitura;
      return aoVivo;
    },
    listarMensagens: async () => {
      aoListarMensagens?.();
      return mensagens;
    },
    obterContato: async () => ({ telefone: "+5584987654321" }),
    desatribuir: async (conversa: number) => {
      chamadas.push({ tipo: "desatribuir", conversa, porta });
    },
    enviarMensagem: async (conversa: number, texto: string, opcoes?: { privado?: boolean }) => {
      envios++;
      if (falharEnvioNumero === envios) throw new Error("Chatwoot respondeu 500");
      chamadas.push({ tipo: opcoes?.privado ? "nota" : "mensagem", conversa, texto, porta });
      return { id: 900 + envios };
    },
    alternarStatus: async (conversa: number, status: string) => {
      chamadas.push({ tipo: "status", conversa, texto: status, porta });
    },
  }),
}));

vi.mock("@/server/integrations/chatwoot/resolucao", () => ({
  marcarResolvida: async (conversa: number) => {
    resolvidas.push(conversa);
  },
}));

vi.mock("@/server/queue/nps", () => ({
  agendarPesquisaNps: async (id: string, espera = 0) => {
    agendados.push({ id, espera });
  },
}));

vi.mock("./crm", () => ({
  gravarNotaNoCrm: async (args: Record<string, unknown> & { nota: number; notaInterna: (t: string) => Promise<boolean> }) => {
    gravarArgs = args;
    if (semTaskNoCrm) {
      const notaInterna = await args.notaInterna(`⭐ nota ${args.nota}`);
      return { gravadas: [], problemas: ["CRM Atendimentos: nenhuma task"], notaInterna };
    }
    return {
      gravadas: [
        { lista: "CRM Atendimentos", tarefaId: "t1", url: "https://app.clickup.com/t/t1", origem: "conversa" },
      ],
      problemas: [],
      notaInterna: false,
    };
  },
}));

const { avancarPesquisa, executarPesquisasVencidas, TENTATIVAS_MAXIMAS } = await import("./executar");

const pesquisa = (sobre: Partial<Linha> = {}): Linha => ({
  id: "p1",
  chatwootConversationId: 12345,
  inboxId: 29,
  portaAgentId: null,
  telefone: "84987654321",
  status: "AGENDADA",
  marcadaEm: new Date(AGORA - 5_000),
  venceEm: new Date(AGORA - 1_000),
  enviadaEm: null,
  referenciaMensagemId: null,
  lembreteEm: null,
  nota: null,
  notaMensagemId: null,
  respondidaEm: null,
  ultimaMensagemEm: null,
  registro: null,
  resultado: null,
  tentativas: 0,
  criadaEm: new Date(AGORA - 5_000),
  finalizadaEm: null,
  ...sobre,
});

const linha = () => linhas[0];
const aoCliente = () => chamadas.filter((c) => c.tipo === "mensagem").map((c) => c.texto);
const MENSAGENS_ATE_105: Msg[] = [100, 101, 102, 103, 104, 105].map((id) => ({
  id,
  message_type: id % 2 ? 1 : 0,
  sender: { type: id % 2 ? "user" : "contact" },
}));

beforeEach(() => {
  linhas = [pesquisa()];
  integracaoNps = { enabled: true, config: {} };
  conversaLocal = { id: "conversa-local", portaAgentId: "porta-1" };
  vizinha = null;
  conversasAtualizadas = [];
  recenteDoTelefone = null;
  conflitoAoEnviar = false;
  leituraConfigurada = true;
  atributos = [];
  // Na marcação, a conversa ainda é de quem atendeu.
  aoVivo = { status: "open", assigneeId: 21, assigneeTipo: "User", inboxId: 29, contactId: 555 };
  mensagens = [...MENSAGENS_ATE_105];
  aoListarMensagens = null;
  falharLeitura = null;
  falharEnvioNumero = null;
  envios = 0;
  chamadas = [];
  resolvidas = [];
  agendados = [];
  gravarArgs = null;
  semTaskNoCrm = false;
});

describe("envio da pesquisa", () => {
  it("desmarca, desatribui e manda as três mensagens em ordem, pelo robô da caixa", async () => {
    expect(await avancarPesquisa("p1", AGORA)).toBe(true);

    expect(atributos).toEqual([{ conversa: 12345, atributos: { nps_perdido: null } }]);
    expect(chamadas.map((c) => c.tipo)).toEqual(["desatribuir", "mensagem", "mensagem", "mensagem"]);
    expect(aoCliente()).toEqual([
      TEXTOS_PADRAO.agradecimento,
      TEXTOS_PADRAO.convite,
      TEXTOS_PADRAO.pergunta,
    ]);
    expect(chamadas.every((c) => c.porta === "porta-1")).toBe(true);

    expect(linha()).toMatchObject({
      status: "AGUARDANDO",
      portaAgentId: "porta-1",
      referenciaMensagemId: 105,
      inboxId: 29,
    });
    expect((linha().enviadaEm as Date).getTime()).toBe(AGORA);
    expect((linha().venceEm as Date).getTime()).toBe(AGORA + 3 * HORA);
    // ⚠ Volta ao robô com o relógio da espera zerado: um valor velho, esquecido
    // enquanto a conversa era de uma pessoa, fazia o vigia pedir desculpas pela
    // demora logo depois da nota (conversa 14149, 22/09/2026).
    expect(conversasAtualizadas).toEqual([
      {
        where: { chatwootConversationId: 12345, status: "HUMAN" },
        data: { status: "BOT", aguardandoDesde: null },
      },
    ]);
    // O CRM não é tocado no envio: a task fica como está, e a nota é depois.
    expect(gravarArgs).toBeNull();
    expect(linha().resultado).toBe("pesquisa enviada");
  });

  it("antes da hora não faz nada", async () => {
    linhas = [pesquisa({ venceEm: new Date(AGORA + 1_000) })];
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("AGENDADA");
    expect(atributos).toEqual([]);
  });

  it("conversa já resolvida: desmarca e cancela sem falar com o cliente", async () => {
    aoVivo.status = "resolved";
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("CANCELADA");
    expect(linha().resultado).toBe("a conversa já estava resolvida");
    expect(atributos).toHaveLength(1);
    expect(chamadas).toEqual([]);
  });

  it("caixa fora da pesquisa é cancelada", async () => {
    aoVivo.inboxId = 31;
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("CANCELADA");
    expect(chamadas).toEqual([]);
  });

  it("o mesmo telefone já recebeu nas últimas 24 h", async () => {
    recenteDoTelefone = { chatwootConversationId: 999 };
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("CANCELADA");
    expect(linha().resultado).toContain("conversa #999");
    expect(aoCliente()).toEqual([]);
  });

  it("com o intervalo em 0, o telefone não barra", async () => {
    integracaoNps = { enabled: true, config: { horasEntrePesquisas: 0 } };
    recenteDoTelefone = { chatwootConversationId: 999 };
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("AGUARDANDO");
  });

  it("sem telefone na marcação, lê do contato", async () => {
    linhas = [pesquisa({ telefone: null })];
    await avancarPesquisa("p1", AGORA);

    expect(linha()).toMatchObject({ status: "AGUARDANDO", telefone: "84987654321" });
  });

  it("outra pesquisa em andamento na conversa: cancela sem mandar nada", async () => {
    conflitoAoEnviar = true;
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("CANCELADA");
    expect(linha().resultado).toBe("já havia uma pesquisa em andamento nesta conversa");
    expect(chamadas).toEqual([]);
  });

  it("pesquisa que falha no meio não é repetida", async () => {
    falharEnvioNumero = 2;
    await avancarPesquisa("p1", AGORA);
    await avancarPesquisa("p1", AGORA + 2 * MIN);

    expect(linha().status).toBe("FALHOU");
    expect(linha().resultado).toContain("a pesquisa não saiu inteira");
    expect(aoCliente()).toEqual([TEXTOS_PADRAO.agradecimento]);
  });

  it("sem robô da caixa, falha sem mandar nada", async () => {
    conversaLocal = { id: "conversa-local", portaAgentId: null };
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("FALHOU");
    expect(chamadas).toEqual([]);
  });

  it("conversa que nunca passou por um agente usa o robô da mesma caixa", async () => {
    conversaLocal = null;
    vizinha = { portaAgentId: "porta-da-caixa" };
    await avancarPesquisa("p1", AGORA);

    expect(linha()).toMatchObject({ status: "AGUARDANDO", portaAgentId: "porta-da-caixa" });
    expect(chamadas.every((c) => c.porta === "porta-da-caixa")).toBe(true);
  });

  it("sem token de leitura, falha antes de tocar na conversa", async () => {
    leituraConfigurada = false;
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("FALHOU");
    expect(chamadas).toEqual([]);
  });
});

describe("desligar", () => {
  it("cancela o que estava em andamento, sem agir", async () => {
    integracaoNps = { enabled: false, config: {} };
    linhas = [pesquisa({ status: "AGUARDANDO", portaAgentId: "porta-1" })];
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("CANCELADA");
    expect(chamadas).toEqual([]);
    expect(atributos).toEqual([]);
  });
});

describe("lembrete", () => {
  beforeEach(() => {
    linhas = [pesquisa({ status: "AGUARDANDO", portaAgentId: "porta-1", referenciaMensagemId: 105 })];
    aoVivo = { status: "open", assigneeId: null, assigneeTipo: null, inboxId: 29, contactId: 555 };
    // As três mensagens da pesquisa, pelo robô.
    mensagens = [
      ...MENSAGENS_ATE_105,
      { id: 106, message_type: 1, sender: { type: "agent_bot" } },
      { id: 107, message_type: 1, sender: { type: "agent_bot" } },
      { id: 108, message_type: 1, sender: { type: "agent_bot" } },
    ];
  });

  it("sem nota em 3 h, lembra uma vez e marca a hora de resolver", async () => {
    await avancarPesquisa("p1", AGORA);
    await avancarPesquisa("p1", AGORA + MIN);

    expect(aoCliente()).toEqual([TEXTOS_PADRAO.lembrete]);
    expect(linha().status).toBe("LEMBRADA");
    expect((linha().venceEm as Date).getTime()).toBe(AGORA + HORA);
    expect(linha().resultado).toBe("lembrete enviado");
  });

  it("uma pessoa assumiu: sem lembrete", async () => {
    aoVivo = { ...aoVivo, assigneeId: 21, assigneeTipo: "User" };
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("CANCELADA");
    expect(linha().resultado).toBe("sem lembrete: uma pessoa assumiu a conversa");
    expect(chamadas).toEqual([]);
  });

  it("o próprio robô como dono não impede", async () => {
    aoVivo = { ...aoVivo, assigneeId: 4, assigneeTipo: "AgentBot" };
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("LEMBRADA");
  });

  it("nota interna da equipe depois da pesquisa: sem lembrete", async () => {
    mensagens.push({ id: 109, message_type: 1, sender: { type: "user" } });
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("CANCELADA");
    expect(chamadas).toEqual([]);
  });

  it("resolvida antes do lembrete: expira sem mandar nada", async () => {
    aoVivo.status = "resolved";
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("EXPIRADA");
    expect(chamadas).toEqual([]);
  });
});

describe("sem nota até o fim do prazo", () => {
  beforeEach(() => {
    linhas = [pesquisa({ status: "LEMBRADA", portaAgentId: "porta-1", referenciaMensagemId: 105 })];
    aoVivo = { status: "open", assigneeId: null, assigneeTipo: null, inboxId: 29, contactId: 555 };
  });

  it("resolve a conversa no Chatwoot e no banco", async () => {
    await avancarPesquisa("p1", AGORA);

    expect(chamadas).toEqual([{ tipo: "status", conversa: 12345, texto: "resolved", porta: "porta-1" }]);
    expect(resolvidas).toEqual([12345]);
    expect(linha().status).toBe("EXPIRADA");
    expect(linha().resultado).toBe("conversa resolvida (sem nota até o fim do prazo)");
  });

  it("o cliente escreveu outra coisa depois da pesquisa: não resolve", async () => {
    mensagens.push({ id: 110, message_type: 0, sender: { type: "contact" } });
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("CANCELADA");
    expect(chamadas).toEqual([]);
    expect(resolvidas).toEqual([]);
  });
});

describe("resposta à nota", () => {
  const respondida = (nota: number, sobre: Partial<Linha> = {}) =>
    pesquisa({
      status: "RESPONDIDA",
      portaAgentId: "porta-1",
      nota,
      notaMensagemId: 120,
      referenciaMensagemId: 105,
      respondidaEm: new Date(AGORA),
      ultimaMensagemEm: new Date(AGORA),
      venceEm: new Date(AGORA),
      ...sobre,
    });

  it.each([1, 2, 3])("nota %i pergunta o que aconteceu", async (nota) => {
    linhas = [respondida(nota)];
    await avancarPesquisa("p1", AGORA);
    expect(aoCliente()).toEqual([TEXTOS_PADRAO.notaBaixa]);
  });

  it.each([4, 5])("nota %i agradece", async (nota) => {
    linhas = [respondida(nota)];
    await avancarPesquisa("p1", AGORA);
    expect(aoCliente()).toEqual([TEXTOS_PADRAO.notaAlta]);
  });

  it("marca a hora de resolver 10 min depois, grava no CRM e não resolve ainda", async () => {
    linhas = [respondida(5)];
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("AGRADECIDA");
    expect((linha().venceEm as Date).getTime()).toBe(AGORA + 10 * MIN);
    expect(agendados).toEqual([{ id: "p1", espera: 10 * MIN + 1_000 }]);
    expect(gravarArgs).toMatchObject({ nota: 5, telefone: "84987654321", chatwootConversationId: 12345 });
    expect(linha().registro).toMatchObject({ gravadas: [{ tarefaId: "t1" }] });
    expect(linha().resultado).toBe(
      "nota 5 · gravada em CRM Atendimentos (https://app.clickup.com/t/t1, task da conversa)",
    );
    expect(resolvidas).toEqual([]);
  });

  it("o prazo conta da última mensagem do cliente, não da nota", async () => {
    linhas = [respondida(2, { respondidaEm: new Date(AGORA - MIN), ultimaMensagemEm: new Date(AGORA) })];
    await avancarPesquisa("p1", AGORA);

    expect((linha().venceEm as Date).getTime()).toBe(AGORA + 10 * MIN);
  });

  it("sem task no CRM, a nota fica numa nota interna da conversa", async () => {
    semTaskNoCrm = true;
    linhas = [respondida(3)];
    await avancarPesquisa("p1", AGORA);

    expect(chamadas).toContainEqual({ tipo: "nota", conversa: 12345, texto: "⭐ nota 3", porta: "porta-1" });
    expect(linha().resultado).toContain("nota interna com a nota deixada na conversa");
  });

  it("uma segunda volta não responde de novo", async () => {
    linhas = [respondida(5)];
    await avancarPesquisa("p1", AGORA);
    await avancarPesquisa("p1", AGORA + 1_000);

    expect(aoCliente()).toEqual([TEXTOS_PADRAO.notaAlta]);
  });
});

describe("encerrar depois da nota", () => {
  const agradecida = (sobre: Partial<Linha> = {}) =>
    pesquisa({
      status: "AGRADECIDA",
      portaAgentId: "porta-1",
      nota: 2,
      notaMensagemId: 120,
      referenciaMensagemId: 105,
      respondidaEm: new Date(AGORA - 10 * MIN),
      ultimaMensagemEm: new Date(AGORA - 10 * MIN),
      venceEm: new Date(AGORA),
      ...sobre,
    });

  beforeEach(() => {
    linhas = [agradecida()];
    aoVivo = { status: "open", assigneeId: null, assigneeTipo: null, inboxId: 29, contactId: 555 };
    mensagens = [
      ...MENSAGENS_ATE_105,
      { id: 120, message_type: 0, sender: { type: "contact" } },
      { id: 121, message_type: 1, sender: { type: "agent_bot" } },
    ];
  });

  it("10 min sem o cliente escrever: resolve", async () => {
    await avancarPesquisa("p1", AGORA);

    expect(chamadas).toEqual([{ tipo: "status", conversa: 12345, texto: "resolved", porta: "porta-1" }]);
    expect(resolvidas).toEqual([12345]);
    expect(linha().status).toBe("CONCLUIDA");
    expect(linha().resultado).toBe(
      "conversa resolvida (10 min sem mensagem do cliente depois da nota)",
    );
  });

  it("complemento recomeça o prazo", async () => {
    linhas = [agradecida({ ultimaMensagemEm: new Date(AGORA - 3 * MIN) })];
    await avancarPesquisa("p1", AGORA);

    expect(chamadas).toEqual([]);
    expect(linha().status).toBe("AGRADECIDA");
    expect((linha().venceEm as Date).getTime()).toBe(AGORA + 7 * MIN);
    expect(agendados).toEqual([{ id: "p1", espera: 7 * MIN + 1_000 }]);
  });

  it("o que o cliente escreveu depois da nota não impede de resolver", async () => {
    mensagens.push({ id: 122, message_type: 0, sender: { type: "contact" } });
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("CONCLUIDA");
    expect(resolvidas).toEqual([12345]);
  });

  it("alguém da equipe escreveu depois da nota: não resolve", async () => {
    mensagens.push({ id: 123, message_type: 1, sender: { type: "user" } });
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("CONCLUIDA");
    expect(linha().resultado).toBe("não resolvi: alguém da equipe escreveu na conversa");
    expect(chamadas).toEqual([]);
  });

  it("uma pessoa assumiu depois da nota: não resolve", async () => {
    aoVivo = { ...aoVivo, assigneeId: 21, assigneeTipo: "User" };
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("CONCLUIDA");
    expect(resolvidas).toEqual([]);
  });

  it("complemento que chega durante a conferência não deixa resolver", async () => {
    aoListarMensagens = () => {
      linhas[0].ultimaMensagemEm = new Date(AGORA);
    };
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("AGRADECIDA");
    expect(resolvidas).toEqual([]);
  });
});

describe("falhas", () => {
  beforeEach(() => {
    aoVivo = { status: "open", assigneeId: null, assigneeTipo: null, inboxId: 29, contactId: 555 };
  });

  it("falha na etapa conta tentativa e deixa para o vigia", async () => {
    linhas = [pesquisa({ status: "AGUARDANDO", portaAgentId: "porta-1", referenciaMensagemId: 105 })];
    falharLeitura = new Error("Chatwoot respondeu 502");

    expect(await avancarPesquisa("p1", AGORA)).toBe(false);
    expect(linha()).toMatchObject({ status: "AGUARDANDO", tentativas: 1 });
  });

  it(`na ${TENTATIVAS_MAXIMAS}ª falha seguida, desiste`, async () => {
    linhas = [
      pesquisa({
        status: "AGUARDANDO",
        portaAgentId: "porta-1",
        tentativas: TENTATIVAS_MAXIMAS - 1,
      }),
    ];
    falharLeitura = new Error("Chatwoot respondeu 404");
    await avancarPesquisa("p1", AGORA);

    expect(linha().status).toBe("FALHOU");
    expect(linha().resultado).toBe(
      `desisti depois de ${TENTATIVAS_MAXIMAS} tentativas: Chatwoot respondeu 404`,
    );
  });

  it("o vigia só pega o que venceu e conta as falhas", async () => {
    linhas = [
      pesquisa({ id: "p1", status: "AGUARDANDO", portaAgentId: "porta-1" }),
      pesquisa({ id: "p2", status: "AGUARDANDO", portaAgentId: "porta-1", venceEm: new Date(AGORA + HORA) }),
      pesquisa({ id: "p3", status: "CONCLUIDA", portaAgentId: "porta-1" }),
    ];
    falharLeitura = new Error("fora do ar");

    expect(await executarPesquisasVencidas(AGORA)).toEqual({ vistas: 1, falhas: 1 });
  });
});
