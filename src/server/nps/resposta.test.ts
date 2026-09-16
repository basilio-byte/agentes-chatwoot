import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O que a captura não pode errar: engolir mensagem que era atendimento, deixar
 * o agente responder à nota, e ler um número do meio de outra conversa como nota.
 */

type Linha = Record<string, unknown> & { id: string; status: string };

const AGORA = 1_789_500_000_000;

let linhas: Linha[];
let ligada: boolean;
let agendados: string[];

function casa(linha: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where).every(([campo, condicao]) => {
    const valor = linha[campo];
    if (condicao && typeof condicao === "object" && !(condicao instanceof Date)) {
      const { in: lista } = condicao as { in?: unknown[] };
      return lista ? lista.includes(valor) : false;
    }
    return (valor ?? null) === (condicao ?? null);
  });
}

vi.mock("@/lib/db", () => ({
  db: {
    pesquisaNps: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const achada = linhas.find((l) => casa(l, where));
        return achada ? { ...achada } : null;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const alvo = linhas.filter((l) => casa(l, where));
        for (const l of alvo) Object.assign(l, data);
        return { count: alvo.length };
      },
    },
    integration: { findUnique: async () => ({ enabled: ligada }) },
  },
}));

vi.mock("@/server/queue/nps", () => ({
  agendarPesquisaNps: async (id: string) => {
    agendados.push(id);
  },
}));

const { capturarRespostaDoNps } = await import("./resposta");

const entrega = (content: string, extra: Record<string, unknown> = {}) => ({
  event: "message_created",
  id: 5001,
  content,
  message_type: "incoming",
  private: false,
  sender: { type: "contact" },
  conversation: { id: 12345, status: "open" },
  ...extra,
});

beforeEach(() => {
  linhas = [
    {
      id: "p1",
      chatwootConversationId: 12345,
      status: "AGUARDANDO",
      portaAgentId: null,
      resultado: "pesquisa enviada",
    },
  ];
  ligada = true;
  agendados = [];
});

describe("capturarRespostaDoNps", () => {
  it("a nota é capturada, registrada e adianta o relógio", async () => {
    const captura = await capturarRespostaDoNps(entrega("5"), "porta-1", AGORA);

    expect(captura).toEqual({ capturada: true, detalhe: "nota 5 da pesquisa de satisfação" });
    expect(linhas[0]).toMatchObject({
      status: "RESPONDIDA",
      nota: 5,
      notaMensagemId: 5001,
      portaAgentId: "porta-1",
    });
    expect((linhas[0].venceEm as Date).getTime()).toBe(AGORA);
    expect((linhas[0].ultimaMensagemEm as Date).getTime()).toBe(AGORA);
    expect(agendados).toEqual(["p1"]);
  });

  it("depois do lembrete, a nota ainda vale", async () => {
    linhas[0].status = "LEMBRADA";
    const captura = await capturarRespostaDoNps(entrega("⭐⭐⭐"), "porta-1", AGORA);

    expect(captura.capturada).toBe(true);
    expect(linhas[0]).toMatchObject({ status: "RESPONDIDA", nota: 3 });
  });

  it("outra coisa encerra a pesquisa, e a mensagem vai para o agente", async () => {
    const captura = await capturarRespostaDoNps(entrega("qual o horário de vocês?"), "porta-1", AGORA);

    expect(captura.capturada).toBe(false);
    expect(linhas[0].status).toBe("CANCELADA");
    expect(linhas[0].resultado).toBe(
      "pesquisa enviada · o cliente escreveu outra coisa em vez da nota — sem lembrete e sem resolver",
    );
    expect(agendados).toEqual([]);
  });

  it("depois da nota, o que o cliente escreve é complemento e não vai para o agente", async () => {
    linhas[0] = { ...linhas[0], status: "AGRADECIDA", nota: 2 };
    const captura = await capturarRespostaDoNps(entrega("o atendente demorou muito"), "porta-1", AGORA);

    expect(captura).toEqual({
      capturada: true,
      detalhe: "complemento à pesquisa de satisfação — o agente não foi acionado",
    });
    expect(linhas[0].status).toBe("AGRADECIDA");
    expect((linhas[0].ultimaMensagemEm as Date).getTime()).toBe(AGORA);
  });

  it("um número depois da nota é complemento, não nota nova", async () => {
    linhas[0] = { ...linhas[0], status: "RESPONDIDA", nota: 5 };
    await capturarRespostaDoNps(entrega("4"), "porta-1", AGORA);

    expect(linhas[0]).toMatchObject({ status: "RESPONDIDA", nota: 5 });
    expect(agendados).toEqual([]);
  });

  it("sem pesquisa em andamento, é atendimento", async () => {
    linhas[0].status = "CONCLUIDA";
    const captura = await capturarRespostaDoNps(entrega("5"), "porta-1", AGORA);

    expect(captura.capturada).toBe(false);
    expect(linhas[0].status).toBe("CONCLUIDA");
  });

  it("pesquisa desligada não captura nem cancela", async () => {
    ligada = false;
    const captura = await capturarRespostaDoNps(entrega("5"), "porta-1", AGORA);

    expect(captura.capturada).toBe(false);
    expect(linhas[0].status).toBe("AGUARDANDO");
  });

  it("saída do robô e nota privada não são resposta", async () => {
    expect((await capturarRespostaDoNps(entrega("5", { message_type: "outgoing" }), "porta-1", AGORA)).capturada).toBe(false);
    expect((await capturarRespostaDoNps(entrega("5", { private: true }), "porta-1", AGORA)).capturada).toBe(false);
    expect(linhas[0].status).toBe("AGUARDANDO");
  });

  it("mantém a porta que enviou a pesquisa", async () => {
    linhas[0].portaAgentId = "porta-original";
    await capturarRespostaDoNps(entrega("4"), "outra-porta", AGORA);

    expect(linhas[0].portaAgentId).toBe("porta-original");
  });
});
