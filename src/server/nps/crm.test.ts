import { beforeEach, describe, expect, it, vi } from "vitest";
import { lerConfigNps } from "./config";

/**
 * O CRM pela ferramenta de verdade: só o cliente HTTP do ClickUp é simulado. É a
 * busca por telefone real que confere o número e a janela de 30 dias.
 */

const ATENDIMENTOS = "901306195904";
const COMERCIAL = "901302419821";
const TELEFONE = "84987654321";
const DIA = 24 * 60 * 60 * 1000;

type Tarefa = {
  id: string;
  name: string;
  url: string;
  status: { status: string };
  list: { id: string };
  date_created: string;
  date_updated: string;
  custom_fields: { id: string; value?: unknown }[];
};

let integracao: Record<string, unknown> | null;
let tarefas: Map<string, Tarefa>;
let camposPorLista: Map<string, { id: string; name: string; type: string }[]>;
let chamadasCriar: { output: unknown }[];
let consultaDeChamadas: Record<string, unknown> | null;
let gravacoes: { taskId: string; fieldId: string; value: unknown }[];
let mudancas: { taskId: string; status?: string }[];
let notas: string[];

vi.mock("@/lib/db", () => ({
  db: {
    integration: { findUnique: async () => integracao },
    conversation: { findUnique: async () => ({ id: "conversa-local" }) },
    toolCall: {
      findMany: async (args: Record<string, unknown>) => {
        consultaDeChamadas = args;
        return chamadasCriar;
      },
    },
  },
}));

vi.mock("@/lib/crypto", () => ({ decifrar: () => "pk_teste" }));

vi.mock("@/server/integrations/clickup/client", () => ({
  ClickUpApiError: class extends Error {},
  ClickUpClient: class {
    async obterTarefa(id: string) {
      const tarefa = tarefas.get(id);
      if (!tarefa) throw new Error("ClickUp respondeu 404");
      return tarefa;
    }
    async listarCamposPersonalizados(listId: string) {
      return { fields: camposPorLista.get(listId) ?? [] };
    }
    // O filtro por campo casa trecho e não normaliza: devolver todas as tasks
    // da lista é o pior caso, e a ferramenta precisa conferir o número.
    async buscarTarefas(_teamId: string, opcoes: { listIds?: string[] }) {
      return {
        tasks: [...tarefas.values()].filter((t) => opcoes.listIds?.includes(t.list.id)),
      };
    }
    async definirCampoPersonalizado(taskId: string, fieldId: string, value: unknown) {
      gravacoes.push({ taskId, fieldId, value });
    }
    async atualizarTarefa(taskId: string, dados: { status?: string }) {
      mudancas.push({ taskId, status: dados.status });
      return { ...tarefas.get(taskId)!, status: { status: dados.status ?? "" } };
    }
  },
}));

const { gravarNotaNoCrm } = await import("./crm");

const tarefa = (
  id: string,
  lista: string,
  telefone: string,
  diasAtras: number,
  status = "aberto",
): Tarefa => ({
  id,
  name: `Task ${id}`,
  url: `https://app.clickup.com/t/${id}`,
  status: { status },
  list: { id: lista },
  date_created: String(Date.now() - diasAtras * DIA),
  date_updated: String(Date.now() - diasAtras * DIA),
  custom_fields: [{ id: "cel", value: telefone }],
});

const notaInterna = async (texto: string) => {
  notas.push(texto);
  return true;
};

beforeEach(() => {
  integracao = {
    enabled: true,
    config: {
      teamId: "3089014",
      spaceIdsPermitidos: [],
      listasNomeadas: [
        { nome: "CRM Atendimentos", listId: ATENDIMENTOS },
        { nome: "CRM Comercial", listId: COMERCIAL },
      ],
    },
    credential: { ciphertext: "x", iv: "y", authTag: "z", hint: "••••" },
  };
  tarefas = new Map([
    ["t-conversa", tarefa("t-conversa", ATENDIMENTOS, "+55 84 987654321", 2)],
    // Mais recente, do mesmo telefone: perde para a task criada na conversa.
    ["t-recente-a", tarefa("t-recente-a", ATENDIMENTOS, "+55 84 987654321", 0)],
    ["t-comercial", tarefa("t-comercial", COMERCIAL, "+55 84 98765 4321", 1)],
  ]);
  camposPorLista = new Map([
    [ATENDIMENTOS, [{ id: "cel", name: "CELULAR", type: "phone" }, { id: "nps-a", name: "NPS", type: "emoji" }]],
    [COMERCIAL, [{ id: "cel", name: "CELULAR", type: "phone" }, { id: "nps-c", name: "NPS", type: "emoji" }]],
  ]);
  chamadasCriar = [{ output: { criada: true, id: "t-conversa", lista: "CRM Atendimentos" } }];
  consultaDeChamadas = null;
  gravacoes = [];
  mudancas = [];
  notas = [];
});

describe("gravarNotaNoCrm", () => {
  it("grava na task criada nesta conversa e, na outra lista, na do telefone", async () => {
    const registro = await gravarNotaNoCrm({
      chatwootConversationId: 12345,
      nota: 4,
      telefone: TELEFONE,
      config: lerConfigNps({}),
      notaInterna,
    });

    expect(registro.gravadas).toEqual([
      { lista: "CRM Atendimentos", tarefaId: "t-conversa", url: "https://app.clickup.com/t/t-conversa", origem: "conversa" },
      { lista: "CRM Comercial", tarefaId: "t-comercial", url: "https://app.clickup.com/t/t-comercial", origem: "telefone" },
    ]);
    expect(gravacoes).toEqual([
      { taskId: "t-conversa", fieldId: "nps-a", value: 4 },
      { taskId: "t-comercial", fieldId: "nps-c", value: 4 },
    ]);
    expect(registro.problemas).toEqual([]);
    expect(notas).toEqual([]);
    // Decisão do usuário (16/09/2026): a task fica no status em que estiver.
    expect(mudancas).toEqual([]);
    expect(consultaDeChamadas).toMatchObject({
      where: { toolName: "clickup_criar_tarefa", isError: false, run: { conversationId: "conversa-local" } },
    });
  });

  it("task de outro telefone ou velha demais não recebe a nota: fica a nota interna", async () => {
    chamadasCriar = [];
    tarefas = new Map([
      ["t-velha", tarefa("t-velha", ATENDIMENTOS, "+55 84 987654321", 60)],
      ["t-outro", tarefa("t-outro", COMERCIAL, "+55 84 912345678", 1)],
    ]);

    const registro = await gravarNotaNoCrm({
      chatwootConversationId: 12345,
      nota: 2,
      telefone: TELEFONE,
      config: lerConfigNps({}),
      notaInterna,
    });

    expect(gravacoes).toEqual([]);
    expect(registro.gravadas).toEqual([]);
    expect(registro.notaInterna).toBe(true);
    expect(notas).toHaveLength(1);
    expect(notas[0]).toContain("o cliente deu nota 2");
    expect(notas[0]).toContain("CRM Atendimentos: nenhuma task desta conversa nem do telefone nos últimos 30 dias");
  });

  it("ClickUp desligado: nota interna com o motivo", async () => {
    integracao = { ...integracao!, enabled: false };

    const registro = await gravarNotaNoCrm({
      chatwootConversationId: 12345,
      nota: 5,
      telefone: TELEFONE,
      config: lerConfigNps({}),
      notaInterna,
    });

    expect(registro.problemas).toEqual(["a integração do ClickUp está desligada"]);
    expect(notas[0]).toContain("a integração do ClickUp está desligada");
  });

  it("campo que a lista não tem vira problema, não sucesso", async () => {
    camposPorLista.set(COMERCIAL, [{ id: "cel", name: "CELULAR", type: "phone" }]);

    const registro = await gravarNotaNoCrm({
      chatwootConversationId: 12345,
      nota: 5,
      telefone: TELEFONE,
      config: lerConfigNps({}),
      notaInterna,
    });

    expect(registro.gravadas.map((g) => g.tarefaId)).toEqual(["t-conversa"]);
    expect(registro.problemas).toHaveLength(1);
    expect(registro.problemas[0]).toContain("CRM Comercial: Nada foi alterado");
    // Uma lista recebeu: não há nota interna.
    expect(notas).toEqual([]);
  });
  it("nem a task que recebe a nota muda de status", async () => {
    await gravarNotaNoCrm({
      chatwootConversationId: 12345,
      nota: 1,
      telefone: TELEFONE,
      config: lerConfigNps({}),
      notaInterna,
    });

    expect(gravacoes).toHaveLength(2);
    expect(mudancas).toEqual([]);
  });
});
