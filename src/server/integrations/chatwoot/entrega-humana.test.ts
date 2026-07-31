import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationProvider } from "@/generated/prisma/enums";

/**
 * `transferir_para_humano` é o fim de linha do atendimento automático: depois
 * dela o bot cala. Se ela erra, a conversa fica órfã — status humano, dono
 * nenhum, e o vigia nem olha, porque ele só vigia conversa do bot.
 *
 * A ordem também é regra, não estilo: assim que existe `assignee_id`, a regra
 * global cala o bot. Avisar depois de atribuir é avisar ninguém.
 */

type Chamada = { tipo: string; payload: unknown };

let chamadas: Chamada[];
let agente: {
  handoffEnabled: boolean;
  handoffTeamId: number | null;
  fallbackAtendente: string | null;
};
let atendentesDoChatwoot: { id: number; name: string }[];

vi.mock("@/lib/db", () => ({
  db: {
    agent: { findUniqueOrThrow: async () => agente },
    conversation: { updateMany: async () => ({ count: 1 }) },
  },
}));

vi.mock("./credenciais", () => ({
  clienteDoAgente: async () => ({
    listarAtendentes: async () => atendentesDoChatwoot,
    enviarMensagem: async (
      _id: number,
      texto: string,
      opcoes: { privado?: boolean } = {},
    ) => {
      chamadas.push({
        tipo: opcoes.privado ? "nota" : "mensagem-ao-cliente",
        payload: texto,
      });
    },
    alternarStatus: async () => {},
    atribuir: async (_id: number, destino: unknown) => {
      chamadas.push({ tipo: "atribuir", payload: destino });
    },
    adicionarLabel: async () => {},
  }),
}));

const { chatwootIntegration } = await import("./index");

const tool = chatwootIntegration.tools.find(
  (t) => t.name === "transferir_para_humano",
)!;

const contexto = () => ({
  provider: IntegrationProvider.CHATWOOT,
  config: {},
  credential: null,
  agentId: "pedro",
  chatwootConversationId: 55,
  sinais: {} as { avisouCliente?: boolean },
});

const entrada = {
  motivo: "cliente quer reserva pontual e não sei responder",
  resumo: "Cliente pediu diária de sala privativa.",
  aviso: "Vou te passar para alguém da equipe, um instante! 😊",
};

beforeEach(() => {
  chamadas = [];
  agente = {
    handoffEnabled: true,
    handoffTeamId: null,
    fallbackAtendente: "Basílio",
  };
  atendentesDoChatwoot = [{ id: 7, name: "Basílio Oliveira" }];
});

const soTipos = () => chamadas.map((c) => c.tipo);

describe("transferir_para_humano", () => {
  it("entrega ao responsável padrão do agente", async () => {
    await tool.execute(entrada, contexto());

    const atribuicao = chamadas.find((c) => c.tipo === "atribuir");
    expect(atribuicao?.payload).toEqual({ assigneeId: 7 });
  });

  it("avisa o cliente ANTES de atribuir", async () => {
    await tool.execute(entrada, contexto());

    expect(soTipos()).toEqual([
      "nota",
      "mensagem-ao-cliente",
      "atribuir",
    ]);
  });

  it("sinaliza ao worker que o cliente já foi avisado", async () => {
    // Sem isto o worker acha que o turno terminou mudo e manda a resposta de
    // contorno por cima de uma transferência que deu certo.
    const ctx = contexto();
    await tool.execute(entrada, ctx);

    expect(ctx.sinais.avisouCliente).toBe(true);
  });

  it("sem responsável padrão, a nota avisa que ninguém assumiu", async () => {
    agente.fallbackAtendente = null;

    await tool.execute(entrada, contexto());

    expect(chamadas.some((c) => c.tipo === "atribuir")).toBe(false);
    const nota = String(chamadas.find((c) => c.tipo === "nota")?.payload);
    expect(nota).toContain("Ninguém foi atribuído");
  });

  it("responsável que não existe no Chatwoot não impede a passagem", async () => {
    // O cliente já foi avisado: melhor a conversa cair na fila com a nota
    // dizendo o porquê do que o turno explodir depois do aviso.
    agente.fallbackAtendente = "Kelly";

    await tool.execute(entrada, contexto());

    expect(chamadas.some((c) => c.tipo === "atribuir")).toBe(false);
    expect(soTipos()).toContain("mensagem-ao-cliente");
  });

  it("time do Chatwoot continua valendo, junto com a pessoa", async () => {
    agente.handoffTeamId = 3;

    await tool.execute(entrada, contexto());

    const atribuicao = chamadas.find((c) => c.tipo === "atribuir");
    expect(atribuicao?.payload).toEqual({ assigneeId: 7, teamId: 3 });
  });

  it("transferência desligada não fala com o cliente", async () => {
    agente.handoffEnabled = false;

    await tool.execute(entrada, contexto());

    expect(chamadas).toEqual([]);
  });
});
