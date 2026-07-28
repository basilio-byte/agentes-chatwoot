import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClickUpApiError, ClickUpClient } from "./client";

/**
 * Estes testes travam o **contrato com a API do ClickUp**: método, rota e corpo
 * de cada chamada, conforme a documentação v2. Se alguém mexer no cliente e
 * quebrar uma rota, aqui falha antes de ir para produção.
 */

type Chamada = { url: string; method: string; body?: unknown; headers: Headers };
let chamadas: Chamada[] = [];

function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  chamadas = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    chamadas.push({
      url: String(url),
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init.headers as HeadersInit),
    });
    return responder({ teams: [], tasks: [], comments: [], spaces: [], id: "t1" });
  });
});

afterEach(() => vi.unstubAllGlobals());

const cliente = () => new ClickUpClient("pk_token_de_teste");

describe("autenticação", () => {
  it("manda o token cru, sem Bearer — é o que o ClickUp exige", async () => {
    await cliente().listarWorkspaces();

    expect(chamadas[0].headers.get("Authorization")).toBe("pk_token_de_teste");
    expect(chamadas[0].headers.get("Authorization")).not.toContain("Bearer");
  });

  it("usa a base v2", async () => {
    await cliente().listarWorkspaces();
    expect(chamadas[0].url).toBe("https://api.clickup.com/api/v2/team");
  });
});

describe("hierarquia", () => {
  it("bate nas rotas documentadas", async () => {
    const c = cliente();
    await c.listarSpaces("team1");
    await c.listarFolders("space1");
    await c.listarListasDaFolder("folder1");
    await c.listarListasSemFolder("space1");
    await c.obterLista("list1");

    expect(chamadas.map((ch) => ch.url.replace("https://api.clickup.com/api/v2", ""))).toEqual([
      "/team/team1/space",
      "/space/space1/folder",
      "/folder/folder1/list",
      "/space/space1/list",
      "/list/list1",
    ]);
  });
});

describe("tarefas", () => {
  it("cria com assignees em ARRAY", async () => {
    await cliente().criarTarefa("list1", {
      name: "Trocar lâmpada",
      assignees: [1, 2],
      priority: 2,
    });

    const ch = chamadas[0];
    expect(ch.method).toBe("POST");
    expect(ch.url).toContain("/list/list1/task");
    expect(ch.body).toMatchObject({
      name: "Trocar lâmpada",
      assignees: [1, 2],
      priority: 2,
    });
  });

  it("atualiza com assignees em OBJETO {add, rem} — o erro clássico desta API", async () => {
    await cliente().atualizarTarefa("task1", {
      status: "concluída",
      assignees: { add: [1], rem: [2] },
    });

    const ch = chamadas[0];
    expect(ch.method).toBe("PUT");
    expect(ch.url).toContain("/task/task1");
    expect(ch.body).toEqual({
      status: "concluída",
      assignees: { add: [1], rem: [2] },
    });
    // Se virar array aqui, o ClickUp aceita e não atribui ninguém.
    expect(Array.isArray((ch.body as { assignees: unknown }).assignees)).toBe(false);
  });

  it("busca no workspace com os filtros em array[]", async () => {
    await cliente().buscarTarefas("team1", {
      listIds: ["l1", "l2"],
      statuses: ["aberto"],
      assignees: [7],
      incluirFechadas: true,
    });

    const url = new URL(chamadas[0].url);
    expect(url.pathname).toBe("/api/v2/team/team1/task");
    expect(url.searchParams.getAll("list_ids[]")).toEqual(["l1", "l2"]);
    expect(url.searchParams.getAll("statuses[]")).toEqual(["aberto"]);
    expect(url.searchParams.getAll("assignees[]")).toEqual(["7"]);
    expect(url.searchParams.get("include_closed")).toBe("true");
    expect(url.searchParams.get("page")).toBe("0");
  });
});

describe("comentários", () => {
  it("usa comment_text, que é o nome do campo na API", async () => {
    await cliente().comentarTarefa("task1", "cliente confirmou", {
      notificarTodos: true,
    });

    expect(chamadas[0].method).toBe("POST");
    expect(chamadas[0].url).toContain("/task/task1/comment");
    expect(chamadas[0].body).toEqual({
      comment_text: "cliente confirmou",
      notify_all: true,
    });
  });
});

describe("erros", () => {
  it("traduz 401 em orientação sobre o token", async () => {
    vi.stubGlobal("fetch", async () => responder({ err: "Token invalid" }, 401));

    const r = await cliente().testar();
    expect(r.ok).toBe(false);
    expect(r.mensagem).toContain("pk_");
  });

  it("lança ClickUpApiError com o status preservado", async () => {
    vi.stubGlobal("fetch", async () => responder({ err: "not found" }, 404));

    await expect(cliente().obterTarefa("x")).rejects.toBeInstanceOf(ClickUpApiError);
  });

  it("tenta de novo no 429 respeitando o retry-after", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      if (n === 1) {
        return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
      }
      return responder({ teams: [{ id: "1", name: "Seahub" }] });
    });

    const r = await cliente().testar();
    expect(n).toBe(2);
    expect(r.ok).toBe(true);
  });
});
