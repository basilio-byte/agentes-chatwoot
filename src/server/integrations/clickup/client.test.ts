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

/** Só o caminho, sem a base — deixa a expectativa legível. */
const rota = (i = 0) =>
  chamadas[i].url.replace("https://api.clickup.com/api/v2", "");

describe("estrutura: criação", () => {
  it("cria pasta no espaço e lista dentro da pasta ou solta no espaço", async () => {
    const c = cliente();
    await c.criarFolder("space1", "Manutenção");
    await c.criarListaEmFolder("folder1", { name: "Elétrica" });
    await c.criarListaEmSpace("space1", { name: "Avulsas" });

    expect(chamadas.map((ch) => [ch.method, ch.url.replace("https://api.clickup.com/api/v2", "")])).toEqual([
      ["POST", "/space/space1/folder"],
      ["POST", "/folder/folder1/list"],
      ["POST", "/space/space1/list"],
    ]);
    expect(chamadas[0].body).toEqual({ name: "Manutenção" });
  });
});

describe("exclusão de tarefa", () => {
  it("é DELETE direto na tarefa", async () => {
    await cliente().excluirTarefa("task1");

    expect(chamadas[0].method).toBe("DELETE");
    expect(rota()).toBe("/task/task1");
  });
});

describe("comentários: edição e exclusão", () => {
  it("endereça o comentário sem a tarefa no caminho", async () => {
    const c = cliente();
    await c.editarComentario("c1", { comment_text: "corrigido" });
    await c.excluirComentario("c1");

    expect([chamadas[0].method, rota(0)]).toEqual(["PUT", "/comment/c1"]);
    expect([chamadas[1].method, rota(1)]).toEqual(["DELETE", "/comment/c1"]);
    expect(chamadas[0].body).toEqual({ comment_text: "corrigido" });
  });
});

describe("tags", () => {
  it("manda a tag no CAMINHO, não no corpo", async () => {
    const c = cliente();
    await c.adicionarTag("task1", "urgente");
    await c.removerTag("task1", "urgente");

    expect([chamadas[0].method, rota(0)]).toEqual(["POST", "/task/task1/tag/urgente"]);
    expect([chamadas[1].method, rota(1)]).toEqual(["DELETE", "/task/task1/tag/urgente"]);
    expect(chamadas[0].body).toBeUndefined();
  });

  it("escapa tag com espaço e acento", async () => {
    await cliente().adicionarTag("task1", "manutenção elétrica");

    expect(rota()).toBe("/task/task1/tag/manuten%C3%A7%C3%A3o%20el%C3%A9trica");
  });

  it("lista as tags do espaço", async () => {
    await cliente().listarTags("space1");
    expect(rota()).toBe("/space/space1/tag");
  });
});

describe("checklists", () => {
  it("cria na tarefa, mas os itens penduram no checklist", async () => {
    const c = cliente();
    await c.criarChecklist("task1", "Vistoria");
    await c.adicionarItemChecklist("chk1", { name: "Conferir hidrômetro" });
    await c.atualizarItemChecklist("chk1", "item1", { resolved: true });
    await c.excluirItemChecklist("chk1", "item1");

    expect(chamadas.map((ch) => [ch.method, ch.url.replace("https://api.clickup.com/api/v2", "")])).toEqual([
      ["POST", "/task/task1/checklist"],
      ["POST", "/checklist/chk1/checklist_item"],
      // O id do checklist continua no caminho ao mexer no item.
      ["PUT", "/checklist/chk1/checklist_item/item1"],
      ["DELETE", "/checklist/chk1/checklist_item/item1"],
    ]);
  });
});

describe("registro de tempo", () => {
  it("usa tid (não task_id) no corpo e pendura tudo no team", async () => {
    const c = cliente();
    await c.iniciarCronometro("team1", { tid: "task1" });
    await c.pararCronometro("team1");
    await c.registrarTempo("team1", {
      tid: "task1",
      start: 1_760_000_000_000,
      duration: 1_800_000,
    });

    expect(chamadas.map((ch) => [ch.method, ch.url.replace("https://api.clickup.com/api/v2", "")])).toEqual([
      ["POST", "/team/team1/time_entries/start"],
      ["POST", "/team/team1/time_entries/stop"],
      ["POST", "/team/team1/time_entries"],
    ]);
    expect(chamadas[0].body).toEqual({ tid: "task1" });
    expect(chamadas[2].body).toMatchObject({ tid: "task1", duration: 1_800_000 });
  });

  it("filtra por tarefa e período na listagem", async () => {
    await cliente().listarRegistrosDeTempo("team1", {
      taskId: "task1",
      inicio: 1_760_000_000_000,
      fim: 1_770_000_000_000,
    });

    const url = new URL(chamadas[0].url);
    expect(url.pathname).toBe("/api/v2/team/team1/time_entries");
    expect(url.searchParams.get("task_id")).toBe("task1");
    expect(url.searchParams.get("start_date")).toBe("1760000000000");
    expect(url.searchParams.get("end_date")).toBe("1770000000000");
  });

  it("sem filtro, não deixa '?' sobrando na URL", async () => {
    await cliente().listarRegistrosDeTempo("team1");
    expect(rota()).toBe("/team/team1/time_entries");
  });
});

describe("relacionamentos", () => {
  it("dependência vai no corpo; link vai no caminho", async () => {
    const c = cliente();
    await c.definirDependencia("task1", { depends_on: "task2" });
    await c.vincularTarefas("task1", "task3");

    expect([chamadas[0].method, rota(0)]).toEqual(["POST", "/task/task1/dependency"]);
    expect(chamadas[0].body).toEqual({ depends_on: "task2" });
    expect([chamadas[1].method, rota(1)]).toEqual(["POST", "/task/task1/link/task3"]);
  });
});

describe("campos personalizados", () => {
  it("lista pela lista e grava pela tarefa, com o valor em { value }", async () => {
    const c = cliente();
    await c.listarCamposPersonalizados("list1");
    await c.definirCampoPersonalizado("task1", "field1", "sala 3");

    expect(rota(0)).toBe("/list/list1/field");
    expect([chamadas[1].method, rota(1)]).toEqual(["POST", "/task/task1/field/field1"]);
    expect(chamadas[1].body).toEqual({ value: "sala 3" });
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
