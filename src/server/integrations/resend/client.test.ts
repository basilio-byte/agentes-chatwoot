import { afterEach, describe, expect, it, vi } from "vitest";
import { configuracaoDeEmail, enviarEmail, ResendError } from "./client";

const config = { chave: "re_chave_de_teste", remetente: "Seahub <notas@seahubcoworking.com.br>" };
const email = { para: ["suporte@seahubcoworking.com.br"], assunto: "Assunto", texto: "Texto", idempotencia: "k1" };

afterEach(() => vi.unstubAllGlobals());

describe("configuração de e-mail do servidor", () => {
  it("só existe com a chave E o remetente", () => {
    expect(configuracaoDeEmail({ RESEND_API_KEY: " re_x ", EMAIL_REMETENTE: " a@b.com " })).toEqual({
      chave: "re_x",
      remetente: "a@b.com",
    });
    expect(configuracaoDeEmail({ RESEND_API_KEY: "re_x" })).toBeNull();
    expect(configuracaoDeEmail({ EMAIL_REMETENTE: "a@b.com" })).toBeNull();
    expect(configuracaoDeEmail({})).toBeNull();
  });
});

describe("envio pela Resend", () => {
  it("manda a chave como Bearer, o remetente do servidor e a chave de idempotência", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const r = await enviarEmail(config, email, "https://resend.teste");
    expect(r).toEqual({ id: "em_1" });

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://resend.teste/emails");
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer re_chave_de_teste");
    expect(h["Idempotency-Key"]).toBe("k1");
    expect(JSON.parse(String(init.body))).toMatchObject({
      from: "Seahub <notas@seahubcoworking.com.br>",
      to: ["suporte@seahubcoworking.com.br"],
      subject: "Assunto",
    });
  });

  it("⚠ recusa (domínio não verificado, chave errada) vira erro com a mensagem da Resend", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "The seahub domain is not verified" }), { status: 403 })));
    const erro = await enviarEmail(config, email, "https://r").catch((e) => e);
    expect(erro).toBeInstanceOf(ResendError);
    expect(erro.status).toBe(403);
    expect(erro.message).toMatch(/403.*not verified/);
  });

  it("queda de rede também é ResendError, para quem chama tratar como 'não saiu'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket"); }));
    await expect(enviarEmail(config, email, "https://r")).rejects.toBeInstanceOf(ResendError);
  });
});
