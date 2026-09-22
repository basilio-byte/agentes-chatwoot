import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatwootApiError, ChatwootClient } from "./client";

/**
 * Anexo e macros: as duas capacidades dos materiais prontos.
 *
 * ⚠ O envio de arquivo pelo token do robô nunca tinha rodado contra o Chatwoot
 * quando isto foi escrito (22/09/2026). O que se trava aqui é o que dá para
 * travar sem ele: token, rota e campos do multipart.
 */

type Pedido = { url: string; init: RequestInit };
let pedidos: Pedido[] = [];

function responder(corpo: unknown, status = 200) {
  pedidos = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    pedidos.push({ url: String(url), init });
    return {
      ok: status < 400,
      status,
      json: async () => corpo,
      text: async () => JSON.stringify(corpo),
    } as unknown as Response;
  });
}

afterEach(() => vi.unstubAllGlobals());

const cliente = new ChatwootClient(
  { baseUrl: "https://chatwoot.test", accountId: 1 } as never,
  "token-do-robo",
  "token-de-pessoa",
);

describe("enviarArquivo", () => {
  it("manda pelo token do ROBÔ, como mensagem de saída pública, com o arquivo em attachments[]", async () => {
    responder({ id: 901 });

    const r = await cliente.enviarArquivo(14149, {
      nome: "Sala de Reunião 02 — Capa.png",
      tipo: "image/png",
      bytes: Buffer.from("png"),
    });

    expect(r).toEqual({ id: 901 });
    const [{ url, init }] = pedidos;
    expect(url).toBe("https://chatwoot.test/api/v1/accounts/1/conversations/14149/messages");
    expect(init.method).toBe("POST");
    // ⚠ Com o token de pessoa, a mensagem contaria como "a equipe respondeu"
    // para os prazos, o NPS e a janela.
    expect(init.headers).toEqual({ api_access_token: "token-do-robo" });
    // O fetch escreve o Content-Type com o boundary; fixá-lo quebraria o upload.
    expect(JSON.stringify(init.headers)).not.toContain("Content-Type");

    const corpo = init.body as FormData;
    expect(corpo.get("message_type")).toBe("outgoing");
    expect(corpo.get("private")).toBe("false");
    const anexo = corpo.get("attachments[]") as File;
    expect(anexo.name).toBe("Sala de Reunião 02 — Capa.png");
    expect(anexo.type).toBe("image/png");
  });

  it("recusa do Chatwoot vira erro com o status", async () => {
    responder({ error: "nope" }, 422);
    await expect(
      cliente.enviarArquivo(1, { nome: "a.png", tipo: "image/png", bytes: Buffer.from("x") }),
    ).rejects.toBeInstanceOf(ChatwootApiError);
  });
});

describe("listarMacros", () => {
  it("lê com o token de leitura e aceita a lista dentro de payload", async () => {
    responder({ payload: [{ id: 18, name: "[SR] Seaway Reunião 01/8P" }] });

    const macros = await cliente.listarMacros();

    expect(macros).toEqual([{ id: 18, name: "[SR] Seaway Reunião 01/8P" }]);
    expect((pedidos[0].init.headers as Record<string, string>).api_access_token).toBe(
      "token-de-pessoa",
    );
    expect(pedidos[0].url).toBe("https://chatwoot.test/api/v1/accounts/1/macros");
  });
});
