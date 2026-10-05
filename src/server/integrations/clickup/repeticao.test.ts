import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationProvider } from "@/generated/prisma/enums";
import type { ToolContext } from "../types";
import { aindaVale, tarefasNaLista } from "./repeticao";

/**
 * A barreira de task em dobro. O caso que motivou, conversa 14454: a mesma
 * venda virou três tasks no CRM — duas do vendedor (um "Sim" do cliente bastou
 * para refazer o passo) e uma do CRM pelo checkbox, 43 horas depois.
 */

const LISTA = "901302419821";
const OUTRA_LISTA = "900701122530";

function chamada(output: unknown, minutosAtras: number) {
  return { output, createdAt: new Date(Date.now() - minutosAtras * 60_000) };
}

describe("tarefasNaLista", () => {
  it("acha a task criada nesta lista, da mais recente para a mais antiga", () => {
    const r = tarefasNaLista(
      [
        chamada({ criada: true, id: "velha", url: "u1", nome: "A", listaId: LISTA }, 120),
        chamada({ criada: true, id: "nova", url: "u2", nome: "B", listaId: LISTA }, 10),
      ],
      LISTA,
    );

    expect(r.map((t) => t.id)).toEqual(["nova", "velha"]);
  });

  it("task de outra lista não barra — o CRM de Atendimentos é outro registro", () => {
    expect(
      tarefasNaLista([chamada({ criada: true, id: "x", listaId: OUTRA_LISTA }, 5)], LISTA),
    ).toEqual([]);
  });

  it("recusa, erro de campo e a própria barreira não contam como task criada", () => {
    const r = tarefasNaLista(
      [
        chamada({ erro: "Não criei a tarefa", problemas: [] }, 5),
        chamada({ criada: false, jaExistia: true, tarefa: { id: "y" } }, 4),
        chamada("Não consegui identificar o responsável", 3),
        chamada(null, 2),
      ],
      LISTA,
    );

    expect(r).toEqual([]);
  });

  it("chamada gravada antes de o retorno trazer a lista não barra", () => {
    // Antes de 05/10/2026 o retorno trazia só o NOME da lista.
    expect(
      tarefasNaLista([chamada({ criada: true, id: "z", lista: "💰 CRM COMERCIAL" }, 5)], LISTA),
    ).toEqual([]);
  });
});

describe("aindaVale", () => {
  it("task viva barra; arquivada ou fechada não", () => {
    expect(aindaVale({ status: { type: "open" } })).toBe(true);
    expect(aindaVale({ status: { type: "custom" } })).toBe(true);
    expect(aindaVale({ archived: true, status: { type: "open" } })).toBe(false);
    expect(aindaVale({ status: { type: "closed" } })).toBe(false);
  });
});

// --- de ponta a ponta -------------------------------------------------------

let chamadasGravadas: { output: unknown; createdAt: Date }[] = [];
let consultaDoBanco: Record<string, unknown> | null = null;
let bancoFalha = false;
let tarefasNoClickUp: Record<string, Record<string, unknown> | null> = {};
let criacoes = 0;

vi.mock("@/lib/db", () => ({
  db: {
    toolCall: {
      findMany: async (args: Record<string, unknown>) => {
        consultaDoBanco = args;
        if (bancoFalha) throw new Error("banco fora do ar");
        return chamadasGravadas;
      },
    },
  },
}));

const { clickupIntegration } = await import("./index");
const criar = clickupIntegration.tools.find((t) => t.name === "clickup_criar_tarefa")!;

beforeEach(() => {
  chamadasGravadas = [];
  consultaDoBanco = null;
  bancoFalha = false;
  tarefasNoClickUp = {};
  criacoes = 0;

  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const rota = String(url).replace("https://api.clickup.com/api/v2", "");
    const metodo = init.method ?? "GET";

    if (metodo === "POST" && rota === `/list/${LISTA}/task`) {
      criacoes++;
      return Response.json({
        id: "nova",
        name: "CW — Cliente",
        url: "https://app.clickup.com/t/nova",
        list: { id: LISTA, name: "💰 CRM COMERCIAL" },
      });
    }

    const tarefa = rota.match(/^\/task\/([^/?]+)$/);
    if (metodo === "GET" && tarefa) {
      const achada = tarefasNoClickUp[tarefa[1]];
      if (!achada) return new Response('{"err":"Task not found"}', { status: 404 });
      return Response.json(achada);
    }

    return Response.json({});
  });
});

afterEach(() => vi.unstubAllGlobals());

const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
  provider: IntegrationProvider.CLICKUP,
  config: { teamId: "team1", defaultListId: LISTA, spaceIdsPermitidos: [] },
  credential: "pk_token",
  agentId: "vendedor",
  conversationId: "conversa-14454",
  ...extra,
});

async function executar(c = ctx()) {
  const args = criar.inputSchema.parse({ nome: "CW — Cliente", lista: LISTA });
  return (await criar.execute(args, c)) as Record<string, unknown>;
}

describe("clickup_criar_tarefa na mesma conversa", () => {
  it("⚠ com task viva desta conversa nesta lista, NÃO cria e devolve a existente", async () => {
    chamadasGravadas = [
      chamada(
        { criada: true, id: "86akt378p", url: "https://app.clickup.com/t/86akt378p", listaId: LISTA },
        65,
      ),
    ];
    tarefasNoClickUp["86akt378p"] = {
      id: "86akt378p",
      name: "Venda do sábado",
      url: "https://app.clickup.com/t/86akt378p",
      status: { status: "sem contato", type: "open" },
    };

    const r = await executar();

    expect(criacoes).toBe(0);
    expect(r).toMatchObject({
      criada: false,
      jaExistia: true,
      tarefa: { id: "86akt378p", url: "https://app.clickup.com/t/86akt378p" },
    });
    expect(String(r.observacao)).toMatch(/complete ESSA task/);
  });

  it("a consulta procura em QUALQUER agente da conversa, só nos últimos dias", async () => {
    await executar();

    const where = (consultaDoBanco as { where: Record<string, unknown> }).where;
    expect(where.toolName).toBe("clickup_criar_tarefa");
    expect(where.run).toEqual({ conversationId: "conversa-14454" });
    expect((where.createdAt as { gte: Date }).gte.getTime()).toBeGreaterThan(
      Date.now() - 8 * 86_400_000,
    );
  });

  it("task apagada no ClickUp não barra a nova", async () => {
    chamadasGravadas = [chamada({ criada: true, id: "apagada", listaId: LISTA }, 30)];

    const r = await executar();

    expect(criacoes).toBe(1);
    expect(r).toMatchObject({ criada: true, listaId: LISTA });
  });

  it("task fechada não barra; a viva de antes dela, sim", async () => {
    chamadasGravadas = [
      chamada({ criada: true, id: "perdida", listaId: LISTA }, 10),
      chamada({ criada: true, id: "viva", listaId: LISTA }, 60),
    ];
    tarefasNoClickUp.perdida = { id: "perdida", name: "P", status: { type: "closed" } };
    tarefasNoClickUp.viva = { id: "viva", name: "V", status: { type: "open" } };

    const r = await executar();

    expect(criacoes).toBe(0);
    expect(r).toMatchObject({ jaExistia: true, tarefa: { id: "viva" } });
  });

  it("banco fora do ar não trava a venda: cria", async () => {
    bancoFalha = true;

    const r = await executar();

    expect(criacoes).toBe(1);
    expect(r.criada).toBe(true);
  });

  it("fora de conversa (playground, gatilho, agendamento) nem consulta", async () => {
    await executar(ctx({ conversationId: undefined }));

    expect(consultaDoBanco).toBeNull();
    expect(criacoes).toBe(1);
  });

  it("a task criada grava a lista no retorno — é por ela que a barreira a reconhece", async () => {
    const r = await executar();

    expect(r.listaId).toBe(LISTA);
    expect(tarefasNaLista([chamada(r, 0)], LISTA).map((t) => t.id)).toEqual(["nova"]);
  });
});
