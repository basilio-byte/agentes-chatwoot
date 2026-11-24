import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClickUpApiError } from "@/server/integrations/clickup/client";

/**
 * O lead perdido no CRM, última etapa do follow-up (task 17twvjx1037). O que
 * se marca é o que a equipe marca à mão: Status CRM, Motivo de perda e Data
 * perdido — o status da task não muda. ClickUp e banco simulados.
 */

const CRM = "901302419821";
const AGORA = Date.parse("2026-11-24T13:00:00Z");
const OPCOES = [
  { id: "op-perdido", name: "Perdido", orderindex: 0 },
  { id: "op-ganho", name: "Ganho", orderindex: 1 },
  { id: "op-andamento", name: "Em andamento", orderindex: 2 },
];
const CAMPOS_DA_LISTA = [
  { id: "s", name: "Status CRM", type: "drop_down", type_config: { options: OPCOES } },
  { id: "m", name: "Motivo de perda", type: "drop_down" },
  { id: "d", name: "Data perdido", type: "date" },
];

type Tarefa = {
  id: string;
  url: string;
  list: { id: string };
  archived?: boolean;
  tags: { name: string }[];
  custom_fields: Array<{ id: string; name: string; value?: unknown; type_config?: unknown }>;
};

let tarefas: Map<string, Tarefa>;
let chamadasDb: Array<{ output: unknown; createdAt: Date }>;
let historicoDesde: Date | null;
let executadas: Array<{ ferramenta: string; entrada: Record<string, unknown> }>;
let buscaPorTelefone: unknown;
let recusarCriacaoCompleta: boolean;
let automacaoDesfazPerdido: boolean;
let clickupDesligado: boolean;
let esperas: number[];

function tarefa(id: string, extra: Partial<Tarefa> = {}, status: string = "op-andamento"): Tarefa {
  return {
    id,
    url: `https://app.clickup.com/t/${id}`,
    list: { id: CRM },
    tags: [],
    custom_fields: [{ id: "s", name: "Status CRM", value: status, type_config: { options: OPCOES } }],
    ...extra,
  };
}

vi.mock("@/lib/db", () => ({
  db: {
    conversation: {
      findUnique: async () => ({ id: "conv-local", historicoDesde }),
    },
    toolCall: {
      findMany: async ({ where }: { where: { createdAt: { gte: Date } } }) =>
        chamadasDb.filter((c) => c.createdAt >= where.createdAt.gte),
    },
  },
}));

vi.mock("@/server/integrations/clickup/sistema", () => ({
  abrirClickUp: async () => {
    if (clickupDesligado) return { erro: "a integração do ClickUp está desligada" };
    return {
      config: {},
      cliente: {
        obterTarefa: async (id: string) => {
          const t = tarefas.get(id);
          if (!t) throw new ClickUpApiError(404, "Task not found");
          return structuredClone(t);
        },
        listarCamposPersonalizados: async () => ({ fields: CAMPOS_DA_LISTA }),
      },
      executar: async (ferramenta: string, entrada: Record<string, unknown>) => {
        executadas.push({ ferramenta, entrada });
        switch (ferramenta) {
          case "clickup_buscar_tarefas_por_telefone":
            return buscaPorTelefone;
          case "clickup_criar_tarefa": {
            const campos = entrada.camposPersonalizados as unknown[];
            if (recusarCriacaoCompleta && campos.length > 2) {
              return { erro: "Não criei a tarefa", problemas: [{ campo: "TIPO DE PRODUTO", motivo: "opção não existe" }] };
            }
            tarefas.set("nova", tarefa("nova", {}, "op-andamento"));
            return { criada: true, id: "nova", listaId: CRM };
          }
          case "clickup_definir_campo_personalizado": {
            const t = tarefas.get(entrada.tarefaId as string)!;
            const status = (entrada.campos as { campo: string; valor: string }[]).find((c) => c.campo === "Status CRM");
            if (status && !automacaoDesfazPerdido) t.custom_fields[0].value = "op-perdido";
            return "3 campo(s) preenchido(s) na tarefa.";
          }
          case "clickup_comentar_tarefa":
            return { comentado: true };
          default:
            throw new Error(`ferramenta inesperada: ${ferramenta}`);
        }
      },
    };
  },
}));

const { perderNoCrm } = await import("./perda");

const args = (extra: Record<string, unknown> = {}) => ({
  chatwootConversationId: 15070,
  contato: { nome: "Fulano", telefone: "+5584987654321" },
  produto: "Sala Privativa",
  agente: "Agente de Salas Privativas",
  minutos: 30,
  linkDaConversa: "https://chat/15070",
  agora: AGORA,
  esperar: async (ms: number) => {
    esperas.push(ms);
  },
  ...extra,
});

const chamada = (output: unknown, minutosAtras = 20) => ({
  output,
  createdAt: new Date(AGORA - minutosAtras * 60_000),
});
const nomes = () => executadas.map((e) => e.ferramenta);

beforeEach(() => {
  tarefas = new Map();
  chamadasDb = [];
  historicoDesde = null;
  executadas = [];
  buscaPorTelefone = { total: 0, tarefas: [] };
  recusarCriacaoCompleta = false;
  automacaoDesfazPerdido = false;
  clickupDesligado = false;
  esperas = [];
});

describe("a task que o agente criou nesta conversa", () => {
  it("vira perdida: Status CRM, motivo e data, comentário, e a leitura de volta confirma", async () => {
    tarefas.set("t1", tarefa("t1"));
    chamadasDb = [chamada({ criada: true, id: "t1", listaId: CRM })];

    const r = await perderNoCrm(args());

    expect(r).toMatchObject({ marcada: true, tarefa: { id: "t1", origem: "conversa" }, problemas: [] });
    const definir = executadas.find((e) => e.ferramenta === "clickup_definir_campo_personalizado")!;
    expect(definir.entrada).toEqual({
      tarefaId: "t1",
      campos: [
        { campo: "Status CRM", valor: "Perdido" },
        { campo: "Motivo de perda", valor: "Não respondeu" },
        { campo: "Data perdido", valor: "2026-11-24" },
      ],
    });
    expect(nomes()).toContain("clickup_comentar_tarefa");
    // Nunca procurou pelo telefone nem criou outra.
    expect(nomes()).not.toContain("clickup_buscar_tarefas_por_telefone");
    expect(nomes()).not.toContain("clickup_criar_tarefa");
  });

  it("a que a barreira de task em dobro devolveu (jaExistia) também é desta conversa", async () => {
    tarefas.set("t2", tarefa("t2"));
    chamadasDb = [chamada({ criada: false, jaExistia: true, tarefa: { id: "t2" } })];

    const r = await perderNoCrm(args());

    expect(r).toMatchObject({ marcada: true, tarefa: { id: "t2" } });
  });

  it("⚠ ganha não vira perdida, e nada é escrito", async () => {
    tarefas.set("t1", tarefa("t1", { tags: [{ name: "ganho" }] }));
    chamadasDb = [chamada({ criada: true, id: "t1", listaId: CRM })];

    const r = await perderNoCrm(args());

    expect(r).toMatchObject({ marcada: false, observacao: "a task já está como ganha" });
    expect(nomes()).toEqual([]);
  });

  it("task de OUTRO atendimento (antes do último corte do histórico) não conta", async () => {
    tarefas.set("velha", tarefa("velha"));
    historicoDesde = new Date(AGORA - 60 * 60_000);
    chamadasDb = [chamada({ criada: true, id: "velha", listaId: CRM }, 120)];

    const r = await perderNoCrm(args());

    // Sem task deste atendimento: procura pelo telefone e cria a do registro.
    expect(nomes()).toContain("clickup_criar_tarefa");
    expect(r.tarefa).toMatchObject({ id: "nova", origem: "criada" });
  });

  it("task de outra lista (CRM de Atendimentos) não conta", async () => {
    chamadasDb = [chamada({ criada: true, id: "outra", listaId: "901306195904" })];

    await perderNoCrm(args());

    expect(executadas.some((e) => e.entrada.tarefaId === "outra")).toBe(false);
  });

  it("task apagada (404) vale a próxima", async () => {
    tarefas.set("viva", tarefa("viva"));
    chamadasDb = [
      chamada({ criada: true, id: "apagada", listaId: CRM }, 5),
      chamada({ criada: true, id: "viva", listaId: CRM }, 10),
    ];

    const r = await perderNoCrm(args());

    expect(r.tarefa).toMatchObject({ id: "viva" });
  });
});

describe("sem task nesta conversa", () => {
  it("⚠ o telefone tem task em andamento de outro atendimento: não mexe nem cria", async () => {
    buscaPorTelefone = { total: 1, tarefas: [{ id: "da-equipe", url: "u", emAndamento: true }] };

    const r = await perderNoCrm(args());

    expect(r.observacao).toMatch(/em andamento no CRM Comercial, de outro atendimento/);
    expect(nomes()).toEqual(["clickup_buscar_tarefas_por_telefone"]);
  });

  it("o telefone já foi dado como perdido há pouco: não cria outra", async () => {
    tarefas.set("perdida", tarefa("perdida", {}, "op-perdido"));
    buscaPorTelefone = { total: 1, tarefas: [{ id: "perdida", emAndamento: false }] };

    const r = await perderNoCrm(args());

    expect(r.observacao).toMatch(/marcada como perdida/);
    expect(nomes()).not.toContain("clickup_criar_tarefa");
  });

  it("cria a task do registro, espera as regras do ClickBot e só então marca a perda", async () => {
    const r = await perderNoCrm(args());

    const criar = executadas.find((e) => e.ferramenta === "clickup_criar_tarefa")!;
    expect(criar.entrada).toMatchObject({
      nome: "CW — Fulano",
      lista: CRM,
      status: "sem contato",
      camposPersonalizados: [
        { campo: "NOME CLIENTE", valor: "Fulano" },
        { campo: "CELULAR", valor: "+55 84 987654321" },
        { campo: "TIPO DE PRODUTO", valor: "Sala Privativa" },
        { campo: "CATEGORIA DE SERVIÇO", valor: "Salas privativas" },
        { campo: "Tipo de Atendimento", valor: "Atendimento Comercial" },
      ],
    });
    // Sem responsável e sem VENDEDOR: ninguém da equipe atendeu.
    expect(criar.entrada.responsavel).toBeUndefined();
    expect(JSON.stringify(criar.entrada)).not.toContain("VENDEDOR");
    expect(esperas).toEqual([5_000]);
    expect(nomes().indexOf("clickup_definir_campo_personalizado")).toBeGreaterThan(
      nomes().indexOf("clickup_criar_tarefa"),
    );
    expect(r).toMatchObject({ marcada: true, tarefa: { id: "nova", origem: "criada" } });
  });

  it("opção que o CRM recusa: tenta de novo só com nome e telefone", async () => {
    recusarCriacaoCompleta = true;

    const r = await perderNoCrm(args());

    const criacoes = executadas.filter((e) => e.ferramenta === "clickup_criar_tarefa");
    expect(criacoes).toHaveLength(2);
    expect(criacoes[1].entrada.camposPersonalizados).toEqual([
      { campo: "NOME CLIENTE", valor: "Fulano" },
      { campo: "CELULAR", valor: "+55 84 987654321" },
    ]);
    expect(r.marcada).toBe(true);
  });

  it("a busca pelo telefone falhou: na dúvida, não cria", async () => {
    buscaPorTelefone = { erro: "ClickUp respondeu 500" };

    const r = await perderNoCrm(args());

    expect(nomes()).not.toContain("clickup_criar_tarefa");
    expect(r.problemas[0]).toMatch(/a busca pelo telefone falhou/);
  });
});

describe("o que dá errado vira aviso, nunca exceção", () => {
  it("uma automação desfez o Perdido: a leitura de volta denuncia", async () => {
    tarefas.set("t1", tarefa("t1"));
    chamadasDb = [chamada({ criada: true, id: "t1", listaId: CRM })];
    automacaoDesfazPerdido = true;

    const r = await perderNoCrm(args());

    expect(r.marcada).toBe(false);
    expect(r.problemas[0]).toMatch(/não ficou "Perdido" na leitura de volta/);
  });

  it("ClickUp desligado no painel vale para o sistema também", async () => {
    clickupDesligado = true;

    const r = await perderNoCrm(args());

    expect(r).toMatchObject({ marcada: false, tarefa: null });
    expect(r.problemas[0]).toMatch(/desligada/);
  });
});
