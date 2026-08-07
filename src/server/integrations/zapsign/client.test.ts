import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZapSignClient } from "./client";
import {
  normalizarStatusDeSignatario,
  resolverModelo,
  zapsignConfigSchema,
} from "./config";

/**
 * Testes de contrato: travam método, rota e corpo de cada chamada.
 *
 * Herdados do arquivo que cobria ZapSign e ClickSign lado a lado — a ClickSign
 * foi cancelada em 03/08/2026 e saiu do projeto.
 */

let chamadas: { url: string; init: RequestInit }[];
let resposta: { status: number; corpo: unknown };

beforeEach(() => {
  chamadas = [];
  resposta = { status: 200, corpo: { token: "doc-1", signers: [] } };

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    chamadas.push({ url: String(url), init });
    return {
      ok: resposta.status < 400,
      status: resposta.status,
      json: async () => resposta.corpo,
      text: async () => JSON.stringify(resposta.corpo),
    } as unknown as Response;
  });
});

const config = zapsignConfigSchema.parse({
  modelos: [{ nome: "Contrato de Endereço Fiscal", templateId: "tpl-abc-123" }],
  authModePadrao: "assinaturaTela-tokenEmail",
});

const zap = () => new ZapSignClient(config, "tok_zap");
const ultima = () => chamadas.at(-1)!;
const caminho = () => new URL(ultima().url).pathname;
const headers = () => ultima().init.headers as Record<string, string>;
const corpo = () => JSON.parse(String(ultima().init.body));

describe("autenticação", () => {
  it("manda o token COM Bearer", async () => {
    await zap().detalhar("doc-1");
    expect(headers().Authorization).toBe("Bearer tok_zap");
  });
});

describe("rotas", () => {
  /**
   * A API é Django REST: sem a barra final, o POST vira redirect e o corpo se
   * perde no caminho. É silencioso e horrível de diagnosticar.
   */
  it("toda rota termina em barra", async () => {
    const c = zap();

    await c.criarDocumento({ name: "Contrato", url_pdf: "x", signers: [{ name: "A B" }] });
    expect(caminho()).toMatch(/\/$/);

    await c.detalhar("doc-1");
    expect(caminho()).toBe("/api/v1/docs/doc-1/");

    await c.adicionarSignatario("doc-1", { name: "C D" });
    expect(caminho()).toBe("/api/v1/docs/doc-1/add-signer/");

    await c.listarModelos();
    expect(caminho()).toBe("/api/v1/templates/");

    await c.detalharModelo("tpl-1");
    expect(caminho()).toBe("/api/v1/templates/tpl-1/");

    await c.detalharSignatario("sig-1");
    expect(caminho()).toBe("/api/v1/signers/sig-1/");

    await c.cancelarDocumento("doc-1", "cliente desistiu");
    expect(caminho()).toBe("/api/v1/refuse/");
  });

  /**
   * Listar modelo é `/templates/`; criar documento a partir de um é
   * `/models/create-doc/`. Mesmo conceito, dois prefixos — trocar um pelo outro
   * dá 404 sem explicação.
   */
  it("modelo tem dois prefixos, e cada um vai para o seu", async () => {
    const c = zap();

    await c.listarModelos();
    expect(caminho()).toContain("/templates/");

    await c.criarPorModelo({ template_id: "t", signer_name: "A B", data: [] });
    expect(caminho()).toBe("/api/v1/models/create-doc/");
  });

  it("cancelar leva o token no CORPO, não na rota", async () => {
    await zap().cancelarDocumento("doc-9", "cliente desistiu");

    expect(caminho()).toBe("/api/v1/refuse/");
    expect(corpo()).toEqual({
      doc_token: "doc-9",
      rejected_reason: "cliente desistiu",
    });
  });

  it("excluir é DELETE — outro verbo não faz nada", async () => {
    await zap().excluirDocumento("doc-9");

    expect(ultima().init.method).toBe("DELETE");
    expect(caminho()).toBe("/api/v1/docs/doc-9/");
  });
});

describe("padrões da configuração", () => {
  it("aplica o modo de autenticação em quem não trouxe um", async () => {
    await zap().criarDocumento({
      name: "Contrato",
      url_pdf: "x",
      signers: [{ name: "Maria Silva" }, { name: "João Souza", auth_mode: "tokenSms" }],
    });

    expect(corpo().signers[0].auth_mode).toBe("assinaturaTela-tokenEmail");
    expect(corpo().signers[1].auth_mode).toBe("tokenSms");
  });

  it("WhatsApp automático fica DESLIGADO por padrão — é cobrado por envio", async () => {
    await zap().criarDocumento({ name: "C", url_pdf: "x", signers: [{ name: "Maria Silva" }] });
    expect(corpo().signers[0].send_automatic_whatsapp).toBe(false);

    const ligado = new ZapSignClient(
      zapsignConfigSchema.parse({ whatsappAutomatico: true }),
      "tok",
    );
    await ligado.criarDocumento({ name: "C", url_pdf: "x", signers: [{ name: "Maria Silva" }] });
    expect(corpo().signers[0].send_automatic_whatsapp).toBe(true);
  });
});

describe("modelos por nome", () => {
  it("resolve pelo nome cadastrado", () => {
    expect(resolverModelo("Contrato de Endereço Fiscal", config).templateId).toBe(
      "tpl-abc-123",
    );
  });

  it("nome desconhecido devolve as opções, para o agente se corrigir", () => {
    expect(resolverModelo("Inexistente", config).templateId).toBeUndefined();
    expect(resolverModelo("Inexistente", config).nomes).toEqual([
      "Contrato de Endereço Fiscal",
    ]);
  });
});

/**
 * A mesma informação vem com nomes diferentes em endpoints diferentes.
 * Comparar sem normalizar conclui que ninguém assinou.
 */
describe("status do signatário", () => {
  it("normaliza entre detalhe e listagem", () => {
    expect(normalizarStatusDeSignatario("signed")).toBe("assinou");
    expect(normalizarStatusDeSignatario("assinou")).toBe("assinou");
    expect(normalizarStatusDeSignatario("new")).toBe("nao_abriu");
    expect(normalizarStatusDeSignatario("nao_abriu")).toBe("nao_abriu");
    expect(normalizarStatusDeSignatario("link-opened")).toBe("abriu");
    expect(normalizarStatusDeSignatario(undefined)).toBe("desconhecido");
  });
});
