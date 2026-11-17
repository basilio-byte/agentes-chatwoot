import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatwootApiError, ChatwootClient } from "./client";

/**
 * `anotar_no_contato` falhou em TODA chamada até 05/10/2026: lia o contato com
 * o token de usuário e gravava com o do Agent Bot, que o Chatwoot recusa fora
 * das conversas. E a recusa saía traduzida como "falta token de leitura" — com
 * o token de leitura configurado —, o que escondeu o defeito nas vendas
 * autônomas de 01/10 e 04/10.
 */

type Chamada = { url: string; method: string; token: string; body?: Record<string, unknown> };
let chamadas: Chamada[] = [];
let atributos: Record<string, unknown> = {};

beforeEach(() => {
  chamadas = [];
  atributos = { origem: "site", cnh_status: "conferida" };

  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const token = (init.headers as Record<string, string>).api_access_token;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    chamadas.push({ url: String(url), method, token, body });

    // O Chatwoot de verdade: robô não mexe em contato, nem para ler.
    if (token === "token-do-bot" && String(url).includes("/contacts/")) {
      return new Response(
        JSON.stringify({ error: "Access to this endpoint is not authorized for bots" }),
        { status: 401 },
      );
    }

    // ⚠ O Chatwoot de verdade (4.16.2, `ContactsController`): o PUT faz MERGE do
    // `custom_attributes` com o que já existe — chave que some do corpo continua no
    // contato — e só `destroy_custom_attributes` apaga. Esta fixture já simulou o
    // contrário (PUT substitui), e foi por isso que a limpeza dos campos do contato
    // chegou à produção sem apagar nada (conversa 14665, 17/11/2026).
    if (method === "PUT") {
      atributos = {
        ...atributos,
        ...(body as { custom_attributes: Record<string, unknown> }).custom_attributes,
      };
    }
    if (method === "POST" && String(url).endsWith("/destroy_custom_attributes")) {
      const chaves = (body as { custom_attributes: string[] }).custom_attributes;
      atributos = Object.fromEntries(Object.entries(atributos).filter(([k]) => !chaves.includes(k)));
    }
    return Response.json({ id: 7, custom_attributes: atributos });
  });
});

afterEach(() => vi.unstubAllGlobals());

const config = { baseUrl: "https://chatwoot.exemplo.com", accountId: 1 };

describe("definirAtributosDoContato", () => {
  it("⚠ grava com o token de usuário, como lê — o robô não pode mexer em contato", async () => {
    const cliente = new ChatwootClient(config, "token-do-bot", "token-de-usuario");

    await cliente.definirAtributosDoContato(7, { plano: "Litoral" });

    expect(chamadas.map((c) => [c.method, c.token])).toEqual([
      ["GET", "token-de-usuario"],
      ["PUT", "token-de-usuario"],
    ]);
  });

  it("preserva os atributos que já existiam e apaga só o que veio nulo", async () => {
    const cliente = new ChatwootClient(config, "token-do-bot", "token-de-usuario");

    const gravados = await cliente.definirAtributosDoContato(7, {
      plano: "Litoral",
      cnh_status: null,
    });

    expect(gravados).toEqual({ origem: "site", plano: "Litoral" });
    // E o contato do Chatwoot, de fato: `cnh_status` saiu, o resto ficou.
    expect(atributos).toEqual({ origem: "site", plano: "Litoral" });
  });

  it("⚠ apagar usa o endpoint de remoção, com o token de usuário — omitir a chave do PUT não apaga", async () => {
    const cliente = new ChatwootClient(config, "token-do-bot", "token-de-usuario");

    await cliente.definirAtributosDoContato(7, { cnh_status: null });

    const remocao = chamadas.find((c) => c.url.endsWith("/contacts/7/destroy_custom_attributes"));
    expect(remocao).toMatchObject({
      method: "POST",
      token: "token-de-usuario",
      body: { custom_attributes: ["cnh_status"] },
    });
    expect(atributos).toEqual({ origem: "site" });
  });

  it("sem nada a remover, não chama o endpoint de remoção", async () => {
    const cliente = new ChatwootClient(config, "token-do-bot", "token-de-usuario");

    await cliente.definirAtributosDoContato(7, { plano: "Litoral" });

    expect(chamadas.some((c) => c.url.includes("destroy_custom_attributes"))).toBe(false);
  });

  it("leitura recusada ao robô continua dizendo que falta o token de leitura", async () => {
    const cliente = new ChatwootClient(config, "token-do-bot", null);

    const erro = await cliente
      .definirAtributosDoContato(7, { plano: "Litoral" })
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ChatwootApiError);
    expect(String((erro as Error).message)).toMatch(/permissão de leitura/);
  });

  it("⚠ GRAVAÇÃO recusada ao robô não é descrita como falta de token de leitura", async () => {
    // O Chatwoot recusando ao robô qualquer escrita — o caso em que a mensagem
    // antiga mandava configurar um token que já estava configurado.
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
      const token = (init.headers as Record<string, string>).api_access_token;
      if (token === "token-do-bot" && (init.method ?? "GET") !== "GET") {
        return new Response("Access to this endpoint is not authorized for bots", {
          status: 401,
        });
      }
      return Response.json({ custom_attributes: {} });
    });
    const cliente = new ChatwootClient(config, "token-do-bot", "token-de-usuario");

    const erro = await cliente
      .definirAtributosDaConversa(5, { passar_para_crm: null })
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ChatwootApiError);
    const mensagem = String((erro as Error).message);
    expect(mensagem).not.toMatch(/leitura/);
    expect(mensagem).toMatch(/POST em \/conversations\/5\/custom_attributes/);
  });
});

describe("removerAtributosDoContato", () => {
  it("tira só as chaves pedidas e deixa as outras", async () => {
    const cliente = new ChatwootClient(config, "token-do-bot", "token-de-usuario");

    await cliente.removerAtributosDoContato(7, ["origem"]);

    expect(atributos).toEqual({ cnh_status: "conferida" });
    expect(chamadas.map((c) => [c.method, c.token])).toEqual([["POST", "token-de-usuario"]]);
  });

  it("lista vazia não faz chamada nenhuma", async () => {
    const cliente = new ChatwootClient(config, "token-do-bot", "token-de-usuario");

    await cliente.removerAtributosDoContato(7, []);

    expect(chamadas).toEqual([]);
  });
});
