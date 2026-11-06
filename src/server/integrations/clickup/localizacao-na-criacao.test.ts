import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationProvider } from "@/generated/prisma/enums";
import type { ToolContext } from "../types";
import { esquecerGeocodificacoes } from "../geocodificacao/nominatim";

/**
 * O "📍 Endereço Sócio" de ponta a ponta (06/11/2026): o Everton manda o endereço
 * como TEXTO, o sistema o converte em localização, e a regra "EV SB SP" do ClickBot
 * encontra o campo preenchido. Provado antes, contra a API real do ClickUp, que
 * `{ location: { lat, lng }, formatted_address }` sem `place_id` é aceito.
 *
 * O `fetch` é simulado: ClickUp, consulta de CNPJ (BrasilAPI) e Nominatim.
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
  { id: "f-vend", ...sim("VENDEDOR", "Alan", "Auto Venda") },
  { id: "f-prod", ...sim("TIPO DE PRODUTO", "Endereço Fiscal Litoral", "Sala de reunião") },
  { id: "f-end", name: "📍 Endereço Sócio", type: "location" },
  { id: "f-rg", name: "RG / ID / RNE", type: "short_text" },
  { id: "f-cpf", name: "CPF", type: "short_text" },
];

type Chamada = { url: string; method: string; body?: { custom_fields?: { id: string; value: unknown }[] } };
let chamadas: Chamada[] = [];
let nominatim: () => Response;
let consultasAoMapa: string[] = [];

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  esquecerGeocodificacoes();
  chamadas = [];
  consultasAoMapa = [];
  nominatim = () =>
    json([{ lat: "-5.8300919", lon: "-35.2224058", display_name: "Rua Jaguarari, Candelária, Natal, 59064-500, Brasil" }]);

  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (String(url).startsWith("https://nominatim.openstreetmap.org")) {
      consultasAoMapa.push(new URL(String(url)).searchParams.get("q") ?? "");
      return nominatim();
    }
    if (String(url).startsWith("https://brasilapi.com.br")) return json({ razao_social: "EXEMPLO LTDA" });
    const rota = String(url).replace("https://api.clickup.com/api/v2", "");
    chamadas.push({
      url: rota,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const corpo = rota.includes("/field")
      ? { fields: CAMPOS }
      : { id: "t1", name: "CW — Maria", url: "https://app.clickup.com/t/t1", list: { id: LISTA } };
    return json(corpo);
  });
});

afterEach(() => {
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

const BASE = [
  { campo: "VENDEDOR", valor: "Auto Venda" },
  { campo: "NOME CLIENTE", valor: "Maria Souza Exemplo" },
  { campo: "TIPO DE PRODUTO", valor: "Endereço Fiscal Litoral" },
  { campo: "RG / ID / RNE", valor: "1234567 SSP RN" },
  { campo: "CPF", valor: "11144477735" },
];
const COM_ENDERECO = [
  ...BASE,
  { campo: "📍 Endereço Sócio", valor: "Rua Jaguarari, 4985, Candelária, Natal - RN, 59064-500" },
];

type Retorno = {
  criada: boolean;
  avisos?: string[];
  contrato?: { dadosCompletos: boolean; faltam?: string[] };
};

const executar = (campos: { campo: string; valor: unknown }[]) =>
  criar.execute(
    { nome: "CW — Maria", lista: LISTA, descricao: "Plano Litoral, contrato de 24 meses.", camposPersonalizados: campos },
    ctx,
  ) as Promise<Retorno>;

const gravado = () => chamadas.find((c) => c.method === "POST")!.body!.custom_fields!;
const valor = (id: string) => gravado().find((c) => c.id === id)?.value;

describe("📍 Endereço Sócio na criação da task", () => {
  it("o texto do agente chega ao ClickUp como localização: coordenadas + o endereço, sem place_id", async () => {
    const r = await executar(COM_ENDERECO);

    expect(r.criada).toBe(true);
    expect(valor("f-end")).toEqual({
      location: { lat: -5.8300919, lng: -35.2224058 },
      formatted_address: "Rua Jaguarari, 4985, Candelária, Natal - RN, 59064-500",
    });
  });

  it("com o campo gravado, ele deixa de constar entre o que falta para o contrato", async () => {
    const r = await executar(COM_ENDERECO);

    expect(r.avisos).toBeUndefined();
    expect(r.contrato?.faltam ?? []).not.toContain("Endereço Sócio");
  });

  it("⚠ endereço que o mapa não acha: a task SAI sem o campo, o motivo volta e o campo é cobrado em `faltam`", async () => {
    nominatim = () => json([]);

    // Sem CEP no texto, para não esperar a segunda consulta (1 s) da política do serviço.
    const r = await executar([
      ...BASE,
      { campo: "📍 Endereço Sócio", valor: "um lugar qualquer que ninguém sabe onde é" },
    ]);

    expect(r.criada).toBe(true);
    expect(valor("f-end")).toBeUndefined();
    expect(valor("f-nome")).toBe("Maria Souza Exemplo");
    expect(r.avisos?.[0]).toContain("Endereço Sócio");
    expect(r.contrato?.faltam).toContain("Endereço Sócio");
  });

  it("⚠ Nominatim fora do ar: mesma coisa — a venda não se perde por causa de um pino", async () => {
    nominatim = () => json({ erro: "indisponível" }, 503);

    const r = await executar([...BASE, { campo: "📍 Endereço Sócio", valor: "Rua X, 100, Natal" }]);

    expect(r.criada).toBe(true);
    expect(valor("f-end")).toBeUndefined();
    expect(r.contrato?.faltam).toContain("Endereço Sócio");
  });

  it("task sem o campo de localização não consulta o mapa", async () => {
    await executar(BASE);
    expect(consultasAoMapa).toEqual([]);
  });

  it("consulta o mapa com o endereço limpo, uma vez", async () => {
    await executar(COM_ENDERECO);
    expect(consultasAoMapa).toEqual(["Rua Jaguarari, 4985, Candelária, Natal - RN, 59064-500"]);
  });
});

describe("clickup_definir_campo_personalizado com localização (completar task que já existe)", () => {
  const definir = clickupIntegration.tools.find((t) => t.name === "clickup_definir_campo_personalizado")!;

  it("grava a localização e os outros campos juntos", async () => {
    const r = await definir.execute(
      {
        tarefaId: "t1",
        campos: [
          { campo: "RG / ID / RNE", valor: "1234567 SSP RN" },
          { campo: "📍 Endereço Sócio", valor: "Rua Jaguarari, 4985, Candelária, Natal - RN, 59064-500" },
        ],
      },
      ctx,
    );

    const posts = chamadas.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(String(r)).toContain("2 campo(s)");
    const localizacao = posts.find((c) => c.url.endsWith("/field/f-end"));
    expect(localizacao?.body).toEqual({
      value: {
        location: { lat: -5.8300919, lng: -35.2224058 },
        formatted_address: "Rua Jaguarari, 4985, Candelária, Natal - RN, 59064-500",
      },
    });
  });

  it("⚠ endereço não achado: os outros campos são gravados mesmo assim, e o aviso volta", async () => {
    nominatim = () => json([]);

    const r = (await definir.execute(
      {
        tarefaId: "t1",
        campos: [
          { campo: "RG / ID / RNE", valor: "1234567 SSP RN" },
          { campo: "📍 Endereço Sócio", valor: "um lugar qualquer" },
        ],
      },
      ctx,
    )) as { preenchidos: number; avisos: string[] };

    expect(r.preenchidos).toBe(1);
    expect(r.avisos[0]).toContain("Endereço Sócio");
    expect(chamadas.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});
