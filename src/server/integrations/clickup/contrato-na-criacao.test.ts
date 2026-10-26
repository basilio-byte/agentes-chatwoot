import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationProvider } from "@/generated/prisma/enums";
import type { ToolContext } from "../types";
import { paraTimestamp } from "./formatacao";

/**
 * `clickup_criar_tarefa` de ponta a ponta na venda de endereço fechada pelo
 * agente (conversa 14818, 26/10/2026): o que o sistema acrescenta à task e o que
 * ele devolve ao modelo, que não consegue conferir os campos depois.
 *
 * O `fetch` é simulado, com o ClickUp e a consulta de CNPJ (BrasilAPI).
 */

vi.mock("@/lib/db", () => ({
  db: { toolCall: { findMany: async () => [] } },
}));
vi.mock("@/server/contato/fatos", () => ({ fatosDoClienteDaConversa: async () => ({}) }));
vi.mock("@/server/contato/espelho", () => ({
  atributosDoContatoDaConversa: async () => ({}),
  espelharTaskNoContato: async () => [],
}));

const { clickupIntegration } = await import("./index");

const LISTA = "901302419821";

const sim = (name: string, ...opcoes: string[]) => ({
  name,
  type: "drop_down",
  type_config: { options: opcoes.map((o, i) => ({ id: `${name}-${i}`, name: o })) },
});

const CAMPOS = [
  { id: "f-nome", name: "NOME CLIENTE", type: "short_text" },
  { id: "f-email", name: "E-mail", type: "email" },
  { id: "f-cpf", name: "CPF", type: "short_text" },
  { id: "f-cnpj", name: "CNPJ [CADASTRO]", type: "short_text" },
  { id: "f-vend", ...sim("VENDEDOR", "Alan", "Auto Venda") },
  { id: "f-prod", ...sim("TIPO DE PRODUTO", "Endereço Fiscal Litoral", "Sala de reunião") },
  { id: "f-ramo", ...sim("RAMO DE ATIVIDADE", "Engenharia", "Outros serviços") },
  { id: "f-sede", name: "Sede da Empresa", type: "short_text" },
  { id: "f-resp", name: "RESPONSÁVEL", type: "text" },
  { id: "f-emailr", name: "E-mail do responsável", type: "email" },
  { id: "f-razao", name: "✍️ Razão Social", type: "short_text" },
  { id: "f-rg", name: "RG / ID / RNE", type: "short_text" },
  { id: "f-ini", name: "DATA INICIO CONTRATO", type: "date" },
  { id: "f-fim", name: "DATA DE ENCERRAMENTO CONTRATO [BASE CLIENTES]", type: "date" },
  { id: "f-venc", name: "VENCIMENTO", type: "number" },
];

type Chamada = { url: string; method: string; body?: { custom_fields?: { id: string; value: unknown }[] } };
let chamadas: Chamada[] = [];
let brasilApi: () => Response;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T15:20:00Z")); // 12:20 em São Paulo
  chamadas = [];
  brasilApi = () =>
    new Response(JSON.stringify({ razao_social: "EXEMPLO SERVICOS LTDA" }), { status: 200 });

  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (String(url).startsWith("https://brasilapi.com.br")) return brasilApi();
    const rota = String(url).replace("https://api.clickup.com/api/v2", "");
    chamadas.push({
      url: rota,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const corpo = rota.includes("/field")
      ? { fields: CAMPOS }
      : { id: "t1", name: "CW — Maria", url: "https://app.clickup.com/t/t1", list: { id: LISTA } };
    return new Response(JSON.stringify(corpo), { status: 200, headers: { "content-type": "application/json" } });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ctx: ToolContext = {
  provider: IntegrationProvider.CLICKUP,
  config: { teamId: "team1", defaultListId: LISTA, spaceIdsPermitidos: [] },
  credential: "pk_token",
  agentId: "a1",
  conversationId: "conversa-1",
  chatwootConversationId: 14818,
};

const criar = clickupIntegration.tools.find((t) => t.name === "clickup_criar_tarefa")!;

const DESCRICAO = "Plano Litoral Bianual, pagamento mensal de R$ 96,90, contrato de 24 meses.";
const DO_EVERTON = [
  { campo: "VENDEDOR", valor: "Auto Venda" },
  { campo: "NOME CLIENTE", valor: "Maria Souza Exemplo" },
  { campo: "E-mail", valor: "maria@exemplo.com" },
  { campo: "CNPJ [CADASTRO]", valor: "11.222.333/0001-81" },
  { campo: "Sede da Empresa", valor: "Rua das Flores, 100, Natal/RN, CEP 59000-000" },
  { campo: "TIPO DE PRODUTO", valor: "Endereço Fiscal Litoral" },
  { campo: "RAMO DE ATIVIDADE", valor: "Outros serviços" },
];

type Retorno = {
  criada: boolean;
  contrato?: { dadosCompletos: boolean; faltam?: string[] };
  observacao?: string;
};

const executar = (campos = DO_EVERTON) =>
  criar.execute(
    { nome: "CW — Maria", lista: LISTA, descricao: DESCRICAO, camposPersonalizados: campos },
    ctx,
  ) as Promise<Retorno>;

const gravado = () => chamadas.find((c) => c.method === "POST")!.body!.custom_fields!;
const valor = (id: string) => gravado().find((c) => c.id === id)?.value;

describe("venda de endereço fechada pelo agente", () => {
  it("a task já nasce com responsável, e-mail, datas, vencimento e razão social", async () => {
    const r = await executar();

    expect(r.criada).toBe(true);
    expect(valor("f-resp")).toBe("Maria Souza Exemplo");
    expect(valor("f-emailr")).toBe("maria@exemplo.com");
    expect(valor("f-ini")).toBe(paraTimestamp("2026-10-26"));
    expect(valor("f-fim")).toBe(paraTimestamp("2028-10-25"));
    expect(valor("f-venc")).toBe(26);
    expect(valor("f-razao")).toBe("EXEMPLO SERVICOS LTDA");
  });

  it("o que o agente mandou segue igual, uma vez só", async () => {
    await executar();
    expect(valor("f-sede")).toBe("Rua das Flores, 100, Natal/RN, CEP 59000-000");
    const ids = gravado().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("⚠ devolve ao modelo o que ainda falta e manda dizer a verdade ao cliente", async () => {
    const r = await executar();

    // (A lista deste teste não tem o campo "Endereço Sócio": campo que a lista não tem não é cobrado.)
    expect(r.contrato).toEqual({ dadosCompletos: false, faltam: ["RG / ID / RNE", "CPF"] });
    expect(r.observacao).toContain("AINDA NÃO sobe sozinha");
    expect(r.observacao).toContain("a equipe confirma o envio");
  });

  it("com RG e CPF na task, os dados do contrato estão completos", async () => {
    const r = await executar([
      ...DO_EVERTON,
      { campo: "RG / ID / RNE", valor: "1234567 SSP RN" },
      { campo: "CPF", valor: "11144477735" },
    ]);
    expect(r.contrato).toEqual({ dadosCompletos: true });
    expect(r.observacao).toBeUndefined();
  });

  it("⚠ consulta de CNPJ fora do ar: a task sai igual, sem a razão social, e o retorno cobra o campo", async () => {
    brasilApi = () => new Response("indisponível", { status: 503 });

    const r = await executar();

    expect(r.criada).toBe(true);
    expect(valor("f-razao")).toBeUndefined();
    expect(valor("f-resp")).toBe("Maria Souza Exemplo");
    expect(r.contrato?.faltam).toContain("Razão Social");
  });

  it("ramo de atividade que o agente não mandou aparece como falta", async () => {
    const r = await executar(DO_EVERTON.filter((c) => c.campo !== "RAMO DE ATIVIDADE"));
    expect(r.contrato?.faltam).toContain("RAMO DE ATIVIDADE");
  });
});

describe("o que NÃO é a venda do agente fica exatamente como era", () => {
  it("⚠ task de vendedor humano não ganha campo nenhum nem aviso de contrato", async () => {
    const r = await executar(DO_EVERTON.map((c) => (c.campo === "VENDEDOR" ? { ...c, valor: "Alan" } : c)));

    expect(r.criada).toBe(true);
    expect(r.contrato).toBeUndefined();
    expect(r.observacao).toBeUndefined();
    expect(valor("f-resp")).toBeUndefined();
    expect(valor("f-ini")).toBeUndefined();
  });

  it("⚠ reserva de sala (também Auto Venda) não ganha datas de contrato", async () => {
    const r = await executar(
      DO_EVERTON.map((c) => (c.campo === "TIPO DE PRODUTO" ? { ...c, valor: "Sala de reunião" } : c)),
    );

    expect(r.contrato).toBeUndefined();
    expect(valor("f-ini")).toBeUndefined();
    expect(valor("f-razao")).toBeUndefined();
  });

  it("fora do CRM Comercial a criação não consulta CNPJ nem acrescenta nada", async () => {
    const consultas: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (String(url).startsWith("https://brasilapi.com.br")) consultas.push(String(url));
      const rota = String(url).replace("https://api.clickup.com/api/v2", "");
      chamadas.push({ url: rota, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
      const corpo = rota.includes("/field")
        ? { fields: CAMPOS }
        : { id: "t2", name: "x", list: { id: "outra" } };
      return new Response(JSON.stringify(corpo), { status: 200 });
    });

    const r = (await criar.execute(
      { nome: "x", lista: "901300000000", camposPersonalizados: DO_EVERTON },
      { ...ctx, config: { ...ctx.config, defaultListId: "901300000000" } },
    )) as Retorno;

    expect(r.criada).toBe(true);
    expect(consultas).toEqual([]);
    expect(r.contrato).toBeUndefined();
  });
});
