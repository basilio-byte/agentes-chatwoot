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

    if (method === "PUT") {
      atributos = (body as { custom_attributes: Record<string, unknown> }).custom_attributes;
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
