import { describe, expect, it } from "vitest";
import {
  deTimestamp,
  filtrarPorTexto,
  formatarTarefa,
  normalizar,
  paraTimestamp,
  resolverMembro,
} from "./formatacao";
import type { ClickUpTarefa, ClickUpUsuario } from "./tipos";

const MEMBROS: ClickUpUsuario[] = [
  { id: 1, username: "João Ávila", email: "joao@seahub.com" },
  { id: 2, username: "Ana Souza", email: "ana@seahub.com" },
  { id: 3, username: "Ana Paula Lima", email: "anapaula@seahub.com" },
];

describe("normalização", () => {
  it("remove acento e caixa, para casar nome digitado sem acento", () => {
    expect(normalizar("João Ávila")).toBe("joao avila");
    expect(normalizar("Conceição")).toBe("conceicao");
    expect(normalizar("  ESPAÇO  ")).toBe("espaco");
  });
});

describe("resolução de responsável", () => {
  it("acha por e-mail exato", () => {
    const r = resolverMembro("ana@seahub.com", MEMBROS);
    expect(r).toEqual({ tipo: "achado", usuario: MEMBROS[1] });
  });

  it("acha por nome sem acento", () => {
    const r = resolverMembro("joao avila", MEMBROS);
    expect(r.tipo).toBe("achado");
    if (r.tipo === "achado") expect(r.usuario.id).toBe(1);
  });

  it("acha por parte do nome quando não há dúvida", () => {
    const r = resolverMembro("joão", MEMBROS);
    expect(r.tipo).toBe("achado");
  });

  it("devolve ambiguidade em vez de escolher — atribuir errado é pior", () => {
    const r = resolverMembro("ana", MEMBROS);
    expect(r.tipo).toBe("ambiguo");
    if (r.tipo === "ambiguo") expect(r.candidatos).toHaveLength(2);
  });

  it("nome exato vence o parcial", () => {
    // "Ana Souza" bate exato; "Ana Paula" só bate parcial. Não pode dar ambíguo.
    const r = resolverMembro("Ana Souza", MEMBROS);
    expect(r.tipo).toBe("achado");
    if (r.tipo === "achado") expect(r.usuario.id).toBe(2);
  });

  it("não acha quem não existe", () => {
    expect(resolverMembro("carlos", MEMBROS).tipo).toBe("nenhum");
    expect(resolverMembro("   ", MEMBROS).tipo).toBe("nenhum");
  });
});

describe("filtro por texto", () => {
  const tarefas = [
    { id: "1", name: "Trocar lâmpada da sala 3" },
    { id: "2", name: "Revisar contrato", description: "sala 3 do coworking" },
    { id: "3", name: "Comprar café" },
  ] as ClickUpTarefa[];

  it("existe porque a API do ClickUp não tem busca textual", () => {
    expect(filtrarPorTexto(tarefas, "sala 3").map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("ignora acento e caixa", () => {
    expect(filtrarPorTexto(tarefas, "LAMPADA").map((t) => t.id)).toEqual(["1"]);
  });

  it("sem termo, devolve tudo", () => {
    expect(filtrarPorTexto(tarefas)).toHaveLength(3);
    expect(filtrarPorTexto(tarefas, "  ")).toHaveLength(3);
  });
});

describe("datas", () => {
  it("converte ISO para milissegundos", () => {
    expect(paraTimestamp("2026-08-31")).toBe(Date.parse("2026-08-31"));
  });

  it("ignora entrada inválida em vez de mandar NaN para a API", () => {
    expect(paraTimestamp("amanhã")).toBeUndefined();
    expect(paraTimestamp("")).toBeUndefined();
    expect(paraTimestamp(null)).toBeUndefined();
  });

  it("converte de volta, lidando com o número em string da API", () => {
    expect(deTimestamp(String(Date.parse("2026-08-31T00:00:00Z")))).toBe("2026-08-31");
    expect(deTimestamp(null)).toBeNull();
    expect(deTimestamp("nao-numero")).toBeNull();
  });
});

describe("formatação de tarefa", () => {
  it("reduz o objeto da API ao que o modelo precisa ler", () => {
    const tarefa = {
      id: "abc123",
      name: "Trocar lâmpada",
      status: { status: "em andamento" },
      priority: { id: "2", priority: "high" },
      due_date: String(Date.parse("2026-08-31T00:00:00Z")),
      assignees: [{ id: 1, username: "João" }],
      list: { id: "9", name: "Manutenção" },
      url: "https://app.clickup.com/t/abc123",
      description: "campo que não deve aparecer no resumo",
    } as ClickUpTarefa;

    expect(formatarTarefa(tarefa)).toEqual({
      id: "abc123",
      nome: "Trocar lâmpada",
      status: "em andamento",
      prioridade: "alta",
      vencimento: "2026-08-31",
      responsaveis: ["João"],
      lista: "Manutenção",
      url: "https://app.clickup.com/t/abc123",
    });
  });

  it("entende prioridade nas três formas que a API usa", () => {
    const com = (priority: { id?: string; priority?: string }) =>
      formatarTarefa({ id: "x", name: "n", priority } as ClickUpTarefa).prioridade;

    expect(com({ id: "1", priority: "urgent" })).toBe("urgente");
    expect(com({ priority: "high" })).toBe("alta"); // só o rótulo em inglês
    expect(com({ id: "4" })).toBe("baixa"); // só o id
    expect(com({ priority: "normal" })).toBe("normal");
  });

  it("aguenta tarefa sem status, prioridade ou responsável", () => {
    const r = formatarTarefa({ id: "x", name: "Solta" } as ClickUpTarefa);
    expect(r.status).toBeNull();
    expect(r.prioridade).toBeNull();
    expect(r.responsaveis).toEqual([]);
  });
});
