import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Antes de qualquer import do módulo: `env()` lê o ambiente uma vez e guarda.
process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api/v1";
process.env.OPENROUTER_API_KEY = "chave-de-teste";

import {
  classificarSaldo,
  diasDeSaldo,
  esquecerSaldo,
  interpretarChave,
  interpretarCreditos,
  lerSaldo,
  SALDO_MINIMO_USD,
} from "./saldo";

describe("conta do saldo", () => {
  it("é o comprado menos o gasto, como no fluxo do n8n", () => {
    expect(interpretarCreditos({ data: { total_credits: 100.5, total_usage: 25.75 } }))
      .toEqual({ saldoUsd: 74.75, usadoUsd: 25.75, compradoUsd: 100.5 });
  });

  it("recusa corpo em formato desconhecido em vez de chutar zero", () => {
    expect(interpretarCreditos({})).toBeNull();
    expect(interpretarCreditos({ data: { total_credits: "100", total_usage: 1 } })).toBeNull();
    expect(interpretarCreditos(null)).toBeNull();
  });

  it("lê o que resta do teto da chave", () => {
    expect(interpretarChave({ data: { limit_remaining: 12.5, usage: 7.5 } }))
      .toEqual({ saldoUsd: 12.5, usadoUsd: 7.5 });
  });

  it("⚠ chave sem teto não sabe o saldo — e não vira zero", () => {
    // `limit_remaining: null` quer dizer "esta chave não tem teto", não "acabou".
    expect(interpretarChave({ data: { limit_remaining: null, usage: 7.5 } })).toBeNull();
  });
});

describe("classificação", () => {
  it("avisa abaixo do mínimo e grita no zero", () => {
    // O limite é "abaixo de", como no fluxo do n8n: US$ 20 exatos ainda é ok.
    expect(classificarSaldo(SALDO_MINIMO_USD)).toBe("ok");
    expect(classificarSaldo(SALDO_MINIMO_USD - 0.01)).toBe("baixo");
    expect(classificarSaldo(0.5)).toBe("baixo");
    expect(classificarSaldo(0)).toBe("esgotado");
    expect(classificarSaldo(-3)).toBe("esgotado");
  });
});

describe("dias de saldo", () => {
  it("divide pelo ritmo de gasto", () => {
    expect(diasDeSaldo(30, 1.5)).toBe(20);
  });

  it("sem gasto medido, não promete nada", () => {
    expect(diasDeSaldo(30, 0)).toBeNull();
    expect(diasDeSaldo(30, Number.NaN)).toBeNull();
  });
});

describe("leitura na OpenRouter", () => {
  beforeEach(() => esquecerSaldo());
  afterEach(() => vi.unstubAllGlobals());

  function responder(...respostas: Array<{ status: number; corpo?: unknown }>) {
    const chamadas: string[] = [];
    const fila = [...respostas];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        chamadas.push(String(url));
        const proxima = fila.shift() ?? { status: 500 };
        return {
          ok: proxima.status >= 200 && proxima.status < 300,
          status: proxima.status,
          json: async () => proxima.corpo,
        } as Response;
      }),
    );
    return chamadas;
  }

  it("lê o saldo da conta em /credits", async () => {
    const chamadas = responder({
      status: 200,
      corpo: { data: { total_credits: 100, total_usage: 18.67 } },
    });

    const leitura = await lerSaldo();

    expect(leitura).toMatchObject({ estado: "lido", origem: "conta", saldoUsd: 81.33 });
    expect(chamadas[0]).toBe("https://openrouter.test/api/v1/credits");
  });

  it("chave recusada em /credits cai para /key", async () => {
    const chamadas = responder(
      { status: 403 },
      { status: 200, corpo: { data: { limit_remaining: 5, usage: 95 } } },
    );

    const leitura = await lerSaldo();

    expect(leitura).toMatchObject({ estado: "lido", origem: "chave", saldoUsd: 5 });
    expect(chamadas[1]).toBe("https://openrouter.test/api/v1/key");
  });

  it("chave sem teto: diz o que configurar, em vez de inventar um número", async () => {
    responder({ status: 403 }, { status: 200, corpo: { data: { limit_remaining: null } } });

    const leitura = await lerSaldo();

    expect(leitura.estado).toBe("indisponivel");
    expect(leitura.estado === "indisponivel" && leitura.motivo).toContain(
      "OPENROUTER_MANAGEMENT_KEY",
    );
  });

  it("⚠ falha da OpenRouter não vira saldo zero", async () => {
    responder({ status: 500 });

    const leitura = await lerSaldo();

    expect(leitura.estado).toBe("erro");
    expect(leitura).not.toHaveProperty("saldoUsd");
  });

  it("⚠ queda de rede também não vira saldo zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));

    const leitura = await lerSaldo();

    expect(leitura).toMatchObject({ estado: "erro", motivo: "ECONNRESET" });
  });

  it("erro que não é de permissão não insiste em /key", async () => {
    // Insistir esconderia a causa: o problema não é a chave.
    const chamadas = responder({ status: 500 });
    await lerSaldo();
    expect(chamadas).toHaveLength(1);
  });

  it("guarda a leitura: abrir a tela de novo não é outra ida à OpenRouter", async () => {
    const chamadas = responder({
      status: 200,
      corpo: { data: { total_credits: 10, total_usage: 1 } },
    });

    await lerSaldo();
    await lerSaldo();

    expect(chamadas).toHaveLength(1);
  });

  it("sem chave configurada, não pergunta nada", async () => {
    vi.resetModules();
    const anterior = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const chamadas = responder({ status: 200 });

    try {
      const { lerSaldo: lerSemChave } = await import("./saldo");
      expect(await lerSemChave()).toEqual({ estado: "sem_chave" });
      expect(chamadas).toHaveLength(0);
    } finally {
      process.env.OPENROUTER_API_KEY = anterior;
      vi.resetModules();
    }
  });
});
