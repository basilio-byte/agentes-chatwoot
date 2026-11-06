import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationProvider } from "@/generated/prisma/enums";

/**
 * Férias do Laércio (06/11/2026): o financeiro manda a conversa para ele POR NOME,
 * em quatro prompts. Enquanto ele está fora, o mesmo nome tem de cair no Felipe —
 * sem reescrever prompt — e voltar sozinho no dia seguinte ao último dia.
 *
 * Aqui o que se trava é a LIGAÇÃO: as ferramentas que atribuem a uma pessoa passam
 * pela ausência. A regra em si está em `atendentes.test.ts`.
 */

type Chamada = { tipo: string; payload: unknown };

let chamadas: Chamada[];
let hoje: string;
let agente: { handoffEnabled: boolean; handoffTeamId: number | null; fallbackAtendente: string | null };

const EQUIPE = [
  { id: 5, name: "Laercio Melo" },
  { id: 6, name: "Felipe Fragoso" },
];

vi.mock("@/lib/db", () => ({
  db: {
    agent: { findUniqueOrThrow: async () => agente },
    conversation: { updateMany: async () => ({ count: 1 }) },
  },
}));

vi.mock("@/server/lacunas/registrar", () => ({ registrarLacuna: async () => true }));

vi.mock("./ausencias-config", () => ({
  opcoesDeAusencia: async () => ({
    ausencias: [{ nome: "Laercio", substituto: "Felipe", ate: "2026-11-19" }],
    hoje,
  }),
}));

vi.mock("./credenciais", () => ({
  clienteDoAgente: async () => ({
    listarAtendentes: async () => EQUIPE,
    enviarMensagem: async (_id: number, texto: string, opcoes: { privado?: boolean } = {}) => {
      chamadas.push({ tipo: opcoes.privado ? "nota" : "mensagem-ao-cliente", payload: texto });
    },
    alternarStatus: async () => {},
    atribuir: async (_id: number, destino: unknown) => {
      chamadas.push({ tipo: "atribuir", payload: destino });
    },
    adicionarLabel: async () => {},
  }),
}));

const { chatwootIntegration } = await import("./index");

const ferramenta = (nome: string) => chatwootIntegration.tools.find((t) => t.name === nome)!;

const contexto = () => ({
  provider: IntegrationProvider.CHATWOOT,
  config: {},
  credential: null,
  agentId: "financeiro",
  chatwootConversationId: 77,
  runId: "run-1",
  sinais: {} as { avisouCliente?: boolean },
});

const entradaDeAtribuicao = {
  atendente: "Laércio",
  motivo: "cliente pergunta sobre cobrança",
  resumo: "Cliente quer entender a cobrança de outubro.",
  aviso: "Vou chamar quem cuida do financeiro, um instante! 😊",
};

beforeEach(() => {
  chamadas = [];
  hoje = "2026-11-06";
  agente = { handoffEnabled: true, handoffTeamId: null, fallbackAtendente: "Laercio" };
});

const atribuidoA = () => chamadas.find((c) => c.tipo === "atribuir")?.payload;
const notas = () => chamadas.filter((c) => c.tipo === "nota").map((c) => String(c.payload));

describe("atribuir_para_atendente com o Laércio ausente", () => {
  it("o nome que o prompt escreve cai no substituto", async () => {
    await ferramenta("atribuir_para_atendente").execute(entradaDeAtribuicao, contexto());

    expect(atribuidoA()).toEqual({ assigneeId: 6 });
  });

  it("a nota interna diz que foi no lugar de quem, para a equipe não estranhar", async () => {
    await ferramenta("atribuir_para_atendente").execute(entradaDeAtribuicao, contexto());

    expect(notas()[0]).toContain("Felipe Fragoso");
    expect(notas()[0]).toContain("no lugar de Laercio Melo");
  });

  it("o retorno ao modelo traz o nome REAL de quem recebeu e manda não citar o ausente", async () => {
    const r = (await ferramenta("atribuir_para_atendente").execute(
      entradaDeAtribuicao,
      contexto(),
    )) as Record<string, string>;

    expect(r.para).toBe("Felipe Fragoso");
    expect(r.substituiu).toBe("Laercio Melo");
    expect(r.aviso).toContain("não Laercio Melo");
  });

  it("o aviso ao cliente sai antes de atribuir, como sempre", async () => {
    await ferramenta("atribuir_para_atendente").execute(entradaDeAtribuicao, contexto());

    expect(chamadas.map((c) => c.tipo)).toEqual(["nota", "mensagem-ao-cliente", "atribuir"]);
  });

  it("⚠ no dia seguinte ao último dia, volta para o Laércio sozinha", async () => {
    hoje = "2026-11-20";
    const r = (await ferramenta("atribuir_para_atendente").execute(
      entradaDeAtribuicao,
      contexto(),
    )) as Record<string, string>;

    expect(atribuidoA()).toEqual({ assigneeId: 5 });
    expect(r.substituiu).toBeUndefined();
    expect(notas()[0]).not.toContain("no lugar de");
  });

  it("no último dia ainda vale", async () => {
    hoje = "2026-11-19";
    await ferramenta("atribuir_para_atendente").execute(entradaDeAtribuicao, contexto());

    expect(atribuidoA()).toEqual({ assigneeId: 6 });
  });
});

describe("transferir_para_humano com o responsável padrão ausente", () => {
  const entrada = {
    motivo: "não sei responder",
    resumo: "Cliente pediu algo fora do escopo.",
    aviso: "Vou te passar para alguém da equipe! 😊",
    causa: "falta_de_instrucao",
    oQueFaltou: "preço da diária de sala privativa",
  };

  it("o responsável padrão ausente é trocado pelo substituto", async () => {
    await ferramenta("transferir_para_humano").execute(entrada, contexto());

    expect(atribuidoA()).toEqual({ assigneeId: 6 });
    expect(notas()[0]).toContain("no lugar de Laercio Melo");
  });
});
