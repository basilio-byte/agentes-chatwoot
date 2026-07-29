import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatwootClient } from "./client";

/**
 * Labels viram o combinado entre nós e qualquer outro bot na mesma caixa — um
 * fluxo do n8n, por exemplo. O endpoint do Chatwoot **substitui** a lista
 * inteira, então mandar o nosso label sozinho apagaria o do outro, que é
 * justamente o critério de quem responde.
 */

type Chamada = { url: string; method: string; body?: Record<string, unknown> };
let chamadas: Chamada[] = [];
let labelsAtuais: string[] = [];

beforeEach(() => {
  chamadas = [];
  labelsAtuais = ["cliente-vip", "n8n-atendendo"];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    chamadas.push({ url: String(url), method, body });

    if (String(url).endsWith("/labels")) {
      if (method === "POST") {
        labelsAtuais = (body as { labels: string[] }).labels;
        return Response.json({ payload: labelsAtuais });
      }
      return Response.json({ payload: labelsAtuais });
    }
    return Response.json({ id: 1 });
  });
});

afterEach(() => vi.unstubAllGlobals());

const cliente = () =>
  new ChatwootClient(
    { baseUrl: "https://chatwoot.seahealth.io", accountId: 1 },
    "token-do-bot",
  );

describe("adicionarLabel", () => {
  it("preserva os labels que já existiam", async () => {
    const r = await cliente().adicionarLabel(55, "transferido-pelo-bot");

    expect(r.mudou).toBe(true);
    expect(labelsAtuais).toEqual([
      "cliente-vip",
      "n8n-atendendo",
      "transferido-pelo-bot",
    ]);
  });

  it("não repete label que já está lá, nem gasta um POST", async () => {
    const r = await cliente().adicionarLabel(55, "cliente-vip");

    expect(r.mudou).toBe(false);
    expect(chamadas.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("removerLabel", () => {
  it("tira só o pedido e devolve o resto", async () => {
    await cliente().removerLabel(55, "n8n-atendendo");

    expect(labelsAtuais).toEqual(["cliente-vip"]);
  });

  it("label ausente não vira requisição", async () => {
    await cliente().removerLabel(55, "inexistente");

    expect(chamadas.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("definirLabels", () => {
  it("substitui mesmo — é o comportamento do endpoint, e o nome avisa", async () => {
    await cliente().definirLabels(55, ["so-este"]);

    expect(labelsAtuais).toEqual(["so-este"]);
  });
});

describe("obterConversa", () => {
  it("traz labels e inbox, que é o que decide quem é o dono da conversa", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        id: 55,
        status: "pending",
        inbox_id: 3,
        labels: ["n8n-atendendo"],
        assignee_id: null,
      }),
    );

    const conversa = await cliente().obterConversa(55);

    expect(conversa).toMatchObject({
      status: "pending",
      inboxId: 3,
      labels: ["n8n-atendendo"],
      assigneeId: null,
    });
  });

  it("instância que não devolve labels não quebra a leitura", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ id: 55, status: "open" }));

    const conversa = await cliente().obterConversa(55);
    expect(conversa.labels).toEqual([]);
  });
});
