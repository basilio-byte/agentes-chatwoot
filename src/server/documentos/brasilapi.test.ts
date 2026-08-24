import { afterEach, describe, expect, it, vi } from "vitest";
import { consultarCNPJ, lerEmpresa } from "./brasilapi";

/**
 * A regra que estes testes protegem: **serviço fora do ar não é empresa
 * inexistente.** A consulta é de um projeto comunitário, sem compromisso de
 * disponibilidade — concluir "CNPJ inválido" a partir de um timeout seria
 * recusar um cliente por causa de um problema nosso.
 */

afterEach(() => vi.unstubAllGlobals());

function respondeCom(status: number, corpo?: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => corpo,
    })),
  );
}

describe("leitura do retorno", () => {
  it("extrai o que interessa para a conferência", () => {
    const e = lerEmpresa(
      {
        cnpj: "34028316000103",
        razao_social: "EMPRESA BRASILEIRA DE CORREIOS E TELEGRAFOS",
        nome_fantasia: "CORREIOS",
        descricao_situacao_cadastral: "ATIVA",
        municipio: "BRASILIA",
        uf: "DF",
      },
      "34028316000103",
    );

    expect(e.razaoSocial).toContain("CORREIOS");
    expect(e.situacao).toBe("ATIVA");
    expect(e.uf).toBe("DF");
  });

  it("campo ausente vira null em vez de quebrar a leitura", () => {
    // O shape do retorno é de terceiro: campo que some não pode derrubar a
    // conferência inteira.
    const e = lerEmpresa({}, "11222333000181");

    expect(e.cnpj).toBe("11222333000181");
    expect(e.razaoSocial).toBeNull();
    expect(e.situacao).toBeNull();
  });

  it("resposta que nem é objeto não estoura", () => {
    expect(lerEmpresa(null, "123").cnpj).toBe("123");
    expect(lerEmpresa("lixo", "123").razaoSocial).toBeNull();
  });
});

describe("consulta", () => {
  it("devolve a empresa quando encontra", async () => {
    respondeCom(200, { razao_social: "ACME LTDA", descricao_situacao_cadastral: "ATIVA" });

    const r = await consultarCNPJ("11.222.333/0001-81");

    expect(r.achou).toBe(true);
    if (!r.achou) return;
    expect(r.empresa.razaoSocial).toBe("ACME LTDA");
  });

  it("404 é a ÚNICA resposta que autoriza dizer 'não encontrado'", async () => {
    respondeCom(404);

    const r = await consultarCNPJ("11222333000181");

    expect(r.achou).toBe(false);
    if (r.achou) return;
    expect(r.indeterminado).toBeUndefined();
    expect(r.motivo).toContain("não encontrado");
  });

  it("erro do servidor vira INDETERMINADO, não inexistente", async () => {
    respondeCom(503);

    const r = await consultarCNPJ("11222333000181");

    expect(r.achou).toBe(false);
    if (r.achou) return;
    expect(r.indeterminado).toBe(true);
    expect(r.motivo).not.toContain("não encontrado");
  });

  it("queda de rede também é indeterminado", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    );

    const r = await consultarCNPJ("11222333000181");

    expect(r.achou).toBe(false);
    if (r.achou) return;
    expect(r.indeterminado).toBe(true);
    // A mensagem tem de guiar quem lê: não confundir com documento inválido.
    expect(r.motivo).toContain("não conferido");
  });

  it("manda só dígitos para a API", async () => {
    const chamadas: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        chamadas.push(String(url));
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    await consultarCNPJ("11.222.333/0001-81");

    // A pontuação tem de sair do NÚMERO — a URL em si tem pontos.
    expect(chamadas[0].split("/").at(-1)).toBe("11222333000181");
  });
});
