import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ehIncerto,
  ehRecusaDefinitiva,
  NotificaMeApiError,
  NotificaMeClient,
  NotificaMeRedeError,
} from "./client";

const envio = {
  canalId: "canal-1",
  para: "5584999990000",
  template: "template_teste",
  idioma: "pt_BR",
  parametros: [{ nome: "texto", texto: "Maria Teste" }],
};

function resposta(status: number, json: unknown) {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("cliente da NotificaMe", () => {
  it("manda o template no formato que o fluxo do n8n já mandava, com o token no cabeçalho", async () => {
    const f = vi.fn(async () =>
      resposta(200, { direction: "OUT", from: "canal-1", id: "msg-1", status: "queued", to: "5584999990000" }),
    );
    vi.stubGlobal("fetch", f);

    const r = await new NotificaMeClient("token-secreto", "https://notificame.teste").enviarTemplate(envio);

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://notificame.teste/v2/channels/whatsapp/messages");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Api-Token"]).toBe("token-secreto");
    expect(JSON.parse(String(init.body))).toEqual({
      from: "canal-1",
      to: "5584999990000",
      contents: [
        {
          type: "template",
          template: {
            name: "template_teste",
            components: [
              { type: "BODY", parameters: [{ type: "text", parameter_name: "texto", text: "Maria Teste" }] },
            ],
            language: { code: "pt_BR" },
          },
        },
      ],
    });
    expect(r).toEqual({ id: "msg-1", status: "queued" });
  });

  it("resposta aceita sem id continua aceita — o id é só para o rastro", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resposta(200, { status: "queued" })));
    expect(await new NotificaMeClient("k", "https://n").enviarTemplate(envio)).toEqual({
      id: null,
      status: "queued",
    });
  });

  it("⚠ 4xx é recusa definitiva e traz a mensagem; 408, 429 e 5xx são INCERTOS, não recusa", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resposta(400, { message: "Template não encontrado" })));
    const erro = await new NotificaMeClient("k", "https://n").enviarTemplate(envio).catch((e) => e);
    expect(erro).toBeInstanceOf(NotificaMeApiError);
    expect(erro.message).toMatch(/400.*Template não encontrado/);
    expect(ehRecusaDefinitiva(erro)).toBe(true);
    expect(ehIncerto(erro)).toBe(false);

    for (const status of [408, 429, 500, 502, 503]) {
      const e = new NotificaMeApiError(status, "x");
      expect(ehRecusaDefinitiva(e)).toBe(false);
      expect(ehIncerto(e)).toBe(true);
    }
  });

  it("⚠ queda de rede e prazo estourado viram NotificaMeRedeError — pode ter saído", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("socket hang up");
    }));
    const erro = await new NotificaMeClient("k", "https://n").enviarTemplate(envio).catch((e) => e);
    expect(erro).toBeInstanceOf(NotificaMeRedeError);
    expect(ehIncerto(erro)).toBe(true);
    expect(ehRecusaDefinitiva(erro)).toBe(false);
  });

  it("não repete sozinho: uma chamada, mesmo com falha", async () => {
    const f = vi.fn(async () => resposta(503, { message: "indisponível" }));
    vi.stubGlobal("fetch", f);
    await new NotificaMeClient("k", "https://n").enviarTemplate(envio).catch(() => {});
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("lista os templates do canal com o texto do corpo", async () => {
    const f = vi.fn(async () =>
      resposta(200, {
        data: [
          {
            name: "template_teste",
            language: "pt_BR",
            status: "APPROVED",
            category: "UTILITY",
            components: [{ type: "BODY", text: "Olá, {{texto}}.\n\nConforme solicitado." }],
          },
          { name: "sem_corpo", status: "PENDING", components: [] },
          { sem: "nome" },
        ],
        paging: {},
      }),
    );
    vi.stubGlobal("fetch", f);

    const lista = await new NotificaMeClient("k", "https://n").listarTemplates("canal-1");

    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://n/v1/templates/canal-1");
    expect(lista).toEqual([
      {
        nome: "template_teste",
        idioma: "pt_BR",
        status: "APPROVED",
        categoria: "UTILITY",
        corpo: "Olá, {{texto}}.\n\nConforme solicitado.",
      },
      { nome: "sem_corpo", idioma: null, status: "PENDING", categoria: null, corpo: null },
    ]);
  });

  it("formato de lista desconhecido vira lista vazia, não erro", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resposta(200, { outra: "coisa" })));
    expect(await new NotificaMeClient("k", "https://n").listarTemplates("c")).toEqual([]);
  });
});
