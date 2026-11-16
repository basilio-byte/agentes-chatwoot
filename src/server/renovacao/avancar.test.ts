import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O status que ficou para trás: contrato de fim de mês, cujo reajuste foi lançado
 * quando a tarefa ainda estava em `renovação`.
 */

const AGORA = new Date("2026-11-16T13:00:00Z");

type Linha = { externalId: string; resultado: string | null; detalhe: string | null; createdAt: Date };

let eventos: Linha[] = [];
let listagem: Array<Record<string, unknown>> = [];
let vivas: Record<string, Record<string, unknown>> = {};
let escritas: string[] = [];
let comentarios: string[] = [];
let clickupAberto = 0;

vi.mock("@/lib/db", () => ({
  db: {
    webhookEvent: {
      findMany: async () => eventos,
      upsert: async () => undefined,
    },
  },
}));

vi.mock("@/server/integrations/clickup/sistema", () => ({
  abrirClickUp: async () => {
    clickupAberto += 1;
    return {
      cliente: {
        listarTarefasDaLista: async () => ({ tasks: listagem }),
        obterTarefa: async (id: string) => vivas[id],
        atualizarTarefa: async (id: string, d: { status?: string }) => {
          escritas.push(`${id}/status=${d.status}`);
        },
        comentarTarefa: async (_id: string, texto: string) => {
          comentarios.push(texto);
          return { id: "c" };
        },
      },
      config: {},
      executar: async () => undefined,
    };
  },
}));

const { avancarTarefasDoLote, tarefasQueFicaramParaTras } = await import("./avancar");

const propagado = (tarefaId: string, extra: Record<string, unknown> = {}): Linha => ({
  externalId: `reajuste:1:2026-11-20`,
  resultado: "propagado",
  detalhe: JSON.stringify({ contratoId: 1, clienteId: 9, tarefaId, problemas: [], ...extra }),
  createdAt: new Date(),
});

const tarefa = (id: string, status: string) => ({
  id,
  name: `(${id}) CLIENTE`,
  status: { status },
});

function com(lista: Array<ReturnType<typeof tarefa>>) {
  listagem = lista;
  vivas = Object.fromEntries(lista.map((t) => [t.id, t]));
}

beforeEach(() => {
  eventos = [];
  escritas = [];
  comentarios = [];
  clickupAberto = 0;
  com([]);
});

describe("tarefasQueFicaramParaTras", () => {
  it("é a tarefa que a propagação tocou SEM avançar o status", () => {
    const ids = tarefasQueFicaramParaTras([propagado("a"), propagado("b", { statusNovo: "pg pendente - renovação" })]);
    expect([...ids]).toEqual(["a"]);
  });

  it("só valem os desfechos que tocaram a tarefa; reserva em aberto e falha não contam", () => {
    const ids = tarefasQueFicaramParaTras([
      { ...propagado("a"), resultado: "reservado" },
      { ...propagado("b"), resultado: null },
      { ...propagado("c"), detalhe: null },
      { ...propagado("d"), resultado: "já estava em dia" },
      { ...propagado("e"), resultado: "propagado em parte" },
    ]);
    expect([...ids].sort()).toEqual(["d", "e"]);
  });
});

describe("avancarTarefasDoLote", () => {
  it("⚠ sem tarefa nomeada, nem abre o ClickUp", async () => {
    eventos = [];
    const r = await avancarTarefasDoLote({ forcar: true }, AGORA);
    expect(r.acao).toBe("nada a avancar");
    expect(clickupAberto).toBe(0);
  });

  it("leva a `pg pendente` a tarefa nomeada que chegou a `notificação renovação`, e comenta", async () => {
    eventos = [propagado("t1")];
    com([tarefa("t1", "notificação renovação")]);

    const r = await avancarTarefasDoLote({ forcar: true }, AGORA);

    expect(r.avancadas).toEqual(["(t1) CLIENTE"]);
    expect(escritas).toEqual(["t1/status=pg pendente - renovação"]);
    expect(comentarios[0]).toContain("pg pendente - renovação");
  });

  it("⚠ tarefa que NENHUMA reserva nomeou não é tocada", async () => {
    eventos = [propagado("t1")];
    com([tarefa("t1", "notificação renovação"), tarefa("outra", "notificação renovação")]);

    await avancarTarefasDoLote({ forcar: true }, AGORA);

    expect(escritas).toEqual(["t1/status=pg pendente - renovação"]);
  });

  it("⚠ a nomeada ainda em `renovação` espera: pular dali engoliria o e-mail de aviso", async () => {
    eventos = [propagado("t1")];
    // A listagem é só de `notificação renovação`: a tarefa em renovação nem entra.
    com([]);
    const r = await avancarTarefasDoLote({ forcar: true }, AGORA);
    expect(escritas).toEqual([]);
    expect(r.candidatas).toBe(0);
  });

  it("confere ao vivo: se alguém moveu a tarefa agora há pouco, não escreve", async () => {
    eventos = [propagado("t1")];
    listagem = [tarefa("t1", "notificação renovação")];
    vivas = { t1: tarefa("t1", "ongoing") };

    await avancarTarefasDoLote({ forcar: true }, AGORA);

    expect(escritas).toEqual([]);
  });
});
