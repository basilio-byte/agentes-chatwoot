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

const registrarLacuna = vi.fn<(args: Record<string, unknown>) => Promise<boolean>>(
  async () => true,
);
vi.mock("@/server/lacunas/registrar", () => ({
  registrarLacuna: (args: Record<string, unknown>) => registrarLacuna(args),
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
  runId: "run-9",
  sinais: {} as { avisouCliente?: boolean },
});

const entrada = {
  motivo: "cliente quer reserva pontual e não sei responder",
  resumo: "Cliente pediu diária de sala privativa.",
  aviso: "Vou te passar para alguém da equipe, um instante! 😊",
  causa: "falta_de_instrucao",
  oQueFaltou: "preço da diária de sala privativa",
};

beforeEach(() => {
  registrarLacuna.mockClear();
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

describe("transferir_para_humano — relatório de lacunas", () => {
  it("registra a lacuna com o agente que pensava, a execução e a conversa", async () => {
    await tool.execute(entrada, contexto());

    expect(registrarLacuna).toHaveBeenCalledTimes(1);
    expect(registrarLacuna).toHaveBeenCalledWith({
      agentId: "pedro",
      runId: "run-9",
      chatwootConversationId: 55,
      causa: "falta_de_instrucao",
      oQueFaltou: "preço da diária de sala privativa",
      motivo: entrada.motivo,
    });
  });

  it("passar por incapacidade sem dizer o que faltou NÃO transfere", async () => {
    // Sem o `oQueFaltou` a linha do relatório não diria à equipe o que
    // fornecer. Recusa antes de qualquer efeito: nada vai ao cliente.
    const resposta = await tool.execute(
      { ...entrada, oQueFaltou: undefined },
      contexto(),
    );

    expect(String(resposta)).toContain("NÃO feita");
    expect(chamadas).toEqual([]);
    expect(registrarLacuna).not.toHaveBeenCalled();
  });

  it("pedido do cliente transfere sem exigir detalhe", async () => {
    // O agente fez o que devia: não há lacuna a descrever. Quem filtra o que
    // vai para o relatório é `registrarLacuna`, que já recebe a causa.
    await tool.execute(
      { ...entrada, causa: "pedido_do_cliente", oQueFaltou: undefined },
      contexto(),
    );

    expect(soTipos()).toEqual(["nota", "mensagem-ao-cliente", "atribuir"]);
    expect(registrarLacuna).toHaveBeenCalledWith(
      expect.objectContaining({ causa: "pedido_do_cliente" }),
    );
  });

  it("transferência desligada não registra lacuna: o agente segue atendendo", async () => {
    agente.handoffEnabled = false;

    await tool.execute(entrada, contexto());

    expect(registrarLacuna).not.toHaveBeenCalled();
  });

  it("o schema exige a causa — sem ela o runner devolve 'Parâmetros inválidos'", () => {
    const semCausa: Partial<typeof entrada> = { ...entrada };
    delete semCausa.causa;

    expect(tool.inputSchema.safeParse(semCausa).success).toBe(false);
    expect(tool.inputSchema.safeParse({ ...entrada, causa: "outra" }).success).toBe(
      false,
    );
    expect(tool.inputSchema.safeParse(entrada).success).toBe(true);
  });
});
