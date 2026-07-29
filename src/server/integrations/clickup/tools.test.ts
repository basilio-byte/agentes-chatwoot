import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationProvider } from "@/generated/prisma/enums";
import { clickupIntegration } from "./index";
import type { ToolContext } from "../types";

/**
 * Exercita as tools de ponta a ponta com o `fetch` stubado.
 *
 * O caso que motivou: o agente coletava CPF, e-mail e valor e despejava tudo
 * num comentário, porque preencher campo personalizado exigia descobrir ids e
 * uma chamada por campo — caro demais dentro do limite de iterações.
 */

type Chamada = { url: string; method: string; body?: Record<string, unknown> };
let chamadas: Chamada[] = [];

const CAMPOS = [
  { id: "f-cpf", name: "CPF", type: "short_text" },
  { id: "f-email", name: "E-mail", type: "email" },
  { id: "f-valor", name: "Valor", type: "currency" },
  {
    id: "f-per",
    name: "Periodicidade",
    type: "drop_down",
    type_config: { options: [{ id: "op-mensal", name: "Mensal" }] },
  },
];

function stub(respostaPorRota: (rota: string) => unknown) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const rota = String(url).replace("https://api.clickup.com/api/v2", "");
    chamadas.push({
      url: rota,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(respostaPorRota(rota)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

beforeEach(() => {
  chamadas = [];
  stub((rota) => {
    if (rota.includes("/field")) return { fields: CAMPOS };
    if (rota.includes("/task/")) return { id: "t1", name: "Tarefa", list: { id: "l1" } };
    return { id: "t1", name: "Endereço Fiscal", url: "https://app.clickup.com/t/t1" };
  });
});

afterEach(() => vi.unstubAllGlobals());

const ctx: ToolContext = {
  provider: IntegrationProvider.CLICKUP,
  config: { teamId: "team1", defaultListId: "l1", spaceIdsPermitidos: [] },
  credential: "pk_token",
  agentId: "a1",
};

const tool = (nome: string) => clickupIntegration.tools.find((t) => t.name === nome)!;

describe("criar tarefa com campos personalizados", () => {
  it("preenche os campos na própria criação, numa chamada só do agente", async () => {
    const r = (await tool("clickup_criar_tarefa").execute(
      {
        nome: "Endereço Fiscal - Basílio - Litoral",
        camposPersonalizados: [
          { campo: "CPF", valor: "383.570.368-48" },
          { campo: "e-mail", valor: "basilioliveira@gmail.com" },
          { campo: "Valor", valor: "R$ 119,00" },
          { campo: "Periodicidade", valor: "Mensal" },
        ],
      },
      ctx,
    )) as { criada: boolean; camposPreenchidos: number };

    expect(r.criada).toBe(true);
    expect(r.camposPreenchidos).toBe(4);

    // Descobre os campos, depois cria — sem uma chamada por campo.
    expect(chamadas.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /list/l1/field",
      "POST /list/l1/task",
    ]);

    // Nome vira id, "R$ 119,00" vira número, "Mensal" vira o id da opção.
    expect(chamadas[1].body?.custom_fields).toEqual([
      { id: "f-cpf", value: "383.570.368-48" },
      { id: "f-email", value: "basilioliveira@gmail.com" },
      { id: "f-valor", value: 119 },
      { id: "f-per", value: "op-mensal" },
    ]);
  });

  it("não cria a tarefa se um campo não existe — e devolve os que existem", async () => {
    const r = (await tool("clickup_criar_tarefa").execute(
      {
        nome: "Endereço Fiscal",
        camposPersonalizados: [
          { campo: "CPF", valor: "383.570.368-48" },
          { campo: "Estado Civil", valor: "Solteiro" },
        ],
      },
      ctx,
    )) as { erro: string; camposDisponiveis: string[] };

    expect(r.erro).toContain("Não criei a tarefa");
    expect(r.camposDisponiveis).toEqual(["CPF", "E-mail", "Valor", "Periodicidade"]);
    // Tarefa órfã com metade dos dados é pior do que pedir a correção.
    expect(chamadas.some((c) => c.method === "POST")).toBe(false);
  });

  it("sem campos personalizados, não paga a consulta extra", async () => {
    await tool("clickup_criar_tarefa").execute({ nome: "Tarefa simples" }, ctx);

    expect(chamadas.map((c) => c.url)).toEqual(["/list/l1/task"]);
  });
});

describe("preencher campos numa tarefa existente", () => {
  it("descobre a lista pela tarefa e grava um campo por requisição", async () => {
    const r = await tool("clickup_definir_campo_personalizado").execute(
      {
        tarefaId: "t1",
        campos: [
          { campo: "CPF", valor: "383.570.368-48" },
          { campo: "Valor", valor: "119" },
        ],
      },
      ctx,
    );

    expect(r).toContain("2 campo(s)");
    expect(chamadas.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /task/t1",
      "GET /list/l1/field",
      "POST /task/t1/field/f-cpf",
      "POST /task/t1/field/f-valor",
    ]);
    expect(chamadas[3].body).toEqual({ value: 119 });
  });

  it("erra o nome do campo e nada é gravado", async () => {
    const r = (await tool("clickup_definir_campo_personalizado").execute(
      { tarefaId: "t1", campos: [{ campo: "Ramo", valor: "Tecnologia" }] },
      ctx,
    )) as { erro: string };

    expect(r.erro).toContain("Nada foi alterado");
    expect(chamadas.some((c) => c.method === "POST")).toBe(false);
  });
});
