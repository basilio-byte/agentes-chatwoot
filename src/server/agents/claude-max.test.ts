import { beforeEach, describe, expect, it, vi } from "vitest";

let ambiente: Record<string, string | undefined>;
let linhaGlobal: { claudeMaxLigado: boolean; modeloPadrao: string } | null;
let consultasAoBanco: number;

vi.mock("@/lib/env", () => ({ env: () => ambiente }));
vi.mock("@/lib/db", () => ({
  db: {
    motorDosAgentes: {
      findUnique: async () => {
        consultasAoBanco++;
        return linhaGlobal;
      },
    },
  },
}));

const {
  baseUrlClaudeMax,
  claudeMaxConfigurado,
  esquecerCatalogoClaudeMax,
  listarModelosClaudeMax,
  nomeDoModelo,
  planejarMotor,
} = await import("./claude-max");

beforeEach(() => {
  ambiente = { CLAUDE_MAX_BASE_URL: "https://proxy.exemplo/v1", CLAUDE_MAX_API_KEY: "sk-teste" };
  linhaGlobal = null;
  consultasAoBanco = 0;
  esquecerCatalogoClaudeMax();
  vi.unstubAllGlobals();
});

describe("configuração", () => {
  it("a base aceita com ou sem /v1, e sem barra no fim", () => {
    for (const url of ["https://proxy.exemplo", "https://proxy.exemplo/", "https://proxy.exemplo/v1/"]) {
      ambiente.CLAUDE_MAX_BASE_URL = url;
      expect(baseUrlClaudeMax()).toBe("https://proxy.exemplo/v1");
    }
  });

  it("só vale com URL E chave", () => {
    expect(claudeMaxConfigurado()).toBe(true);
    ambiente.CLAUDE_MAX_API_KEY = " ";
    expect(claudeMaxConfigurado()).toBe(false);
    ambiente = { CLAUDE_MAX_API_KEY: "sk" };
    expect(claudeMaxConfigurado()).toBe(false);
  });
});

describe("planejarMotor", () => {
  const agente = { motor: "PADRAO" as const, modeloClaudeMax: null };

  it("⚠ sem linha gravada, a chave geral está desligada: OpenRouter", async () => {
    expect((await planejarMotor(agente)).motor).toBe("OPENROUTER");
  });

  it("chave ligada no banco: Claude MAX com o modelo padrão gravado", async () => {
    linhaGlobal = { claudeMaxLigado: true, modeloPadrao: "claude-haiku-4-5" };
    expect(await planejarMotor(agente)).toMatchObject({ motor: "CLAUDE_MAX", modeloClaude: "claude-haiku-4-5" });
  });

  it("⚠ sem proxy configurado, o turno de sempre não ganha nem uma consulta ao banco", async () => {
    ambiente = {};
    linhaGlobal = { claudeMaxLigado: true, modeloPadrao: "claude-sonnet-5" };
    expect((await planejarMotor(agente)).motor).toBe("OPENROUTER");
    expect(consultasAoBanco).toBe(0);
  });
});

describe("catálogo", () => {
  it("nome legível a partir do id", () => {
    expect(nomeDoModelo("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(nomeDoModelo("claude-haiku-4-5")).toBe("Claude Haiku 4.5");
    expect(nomeDoModelo("claude-fable-5-1")).toBe("Claude Fable 5.1");
  });

  it("lê a lista do proxy, com a chave", async () => {
    const pedidos: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      pedidos.push({ url, auth: new Headers(init.headers).get("authorization") });
      return new Response(
        JSON.stringify({ data: [{ id: "claude-sonnet-5", context_window: 1000000, max_output_tokens: 64000 }] }),
      );
    });

    const { modelos, doProxy } = await listarModelosClaudeMax();
    expect(doProxy).toBe(true);
    expect(modelos).toEqual([{ id: "claude-sonnet-5", nome: "Claude Sonnet 5", contexto: 1000000, maxSaida: 64000 }]);
    expect(pedidos).toEqual([{ url: "https://proxy.exemplo/v1/models", auth: "Bearer sk-teste" }]);
  });

  it("proxy fora do ar: a reserva, dita como reserva", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 502 }));
    const { modelos, doProxy } = await listarModelosClaudeMax();
    expect(doProxy).toBe(false);
    expect(modelos.map((m) => m.id)).toContain("claude-sonnet-5");
  });
});
