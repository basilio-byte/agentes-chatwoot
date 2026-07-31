import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZapSignClient } from "./zapsign/client";
import {
  normalizarStatusDeSignatario,
  resolverModelo,
  zapsignConfigSchema,
} from "./zapsign/config";
import { ClickSignClient } from "./clicksign/client";
import { clicksignConfigSchema, prazoDeAssinatura } from "./clicksign/config";

/**
 * Testes de contrato das duas assinaturas eletrônicas.
 *
 * Ficam no mesmo arquivo de propósito: as armadilhas de autenticação das duas
 * são **opostas** (ZapSign quer `Bearer`, ClickSign recusa), e é exatamente o
 * tipo de coisa que alguém troca ao mexer numa lembrando da outra. Lado a lado,
 * a troca quebra o teste na hora.
 */

let chamadas: { url: string; init: RequestInit }[];
let resposta: { status: number; corpo: unknown };

beforeEach(() => {
  chamadas = [];
  resposta = { status: 200, corpo: { data: { id: "id-1", type: "x" } } };

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

const ultima = () => chamadas.at(-1)!;
const headers = () => ultima().init.headers as Record<string, string>;
const corpo = () => JSON.parse(String(ultima().init.body));

// ─── ZapSign ───────────────────────────────────────────────────────────────

const configZap = zapsignConfigSchema.parse({
  modelos: [{ nome: "Contrato de Endereço Fiscal", templateId: "tpl-abc-123" }],
  authModePadrao: "assinaturaTela-tokenEmail",
});

const zap = () => new ZapSignClient(configZap, "tok_zap");

describe("ZapSign", () => {
  it("manda o token COM Bearer", async () => {
    await zap().detalhar("doc-1");
    expect(headers().Authorization).toBe("Bearer tok_zap");
  });

  /**
   * A API é Django REST: sem a barra final, o POST vira redirect e o corpo se
   * perde no caminho. É silencioso e horrível de diagnosticar.
   */
  it("toda rota termina em barra", async () => {
    await zap().criarDocumento({ name: "Contrato", url_pdf: "x", signers: [{ name: "A B" }] });
    expect(new URL(ultima().url).pathname).toMatch(/\/$/);

    await zap().detalhar("doc-1");
    expect(new URL(ultima().url).pathname).toBe("/api/v1/docs/doc-1/");

    await zap().adicionarSignatario("doc-1", { name: "C D" });
    expect(new URL(ultima().url).pathname).toBe("/api/v1/docs/doc-1/add-signer/");

    await zap().criarPorModelo({ template_id: "t", signer_name: "A B", data: [] });
    expect(new URL(ultima().url).pathname).toBe("/api/v1/models/create-doc/");
  });

  it("aplica o modo de autenticação padrão em quem não trouxe um", async () => {
    await zap().criarDocumento({
      name: "Contrato",
      url_pdf: "x",
      signers: [{ name: "Maria Silva" }, { name: "João Souza", auth_mode: "tokenSms" }],
    });

    expect(corpo().signers[0].auth_mode).toBe("assinaturaTela-tokenEmail");
    expect(corpo().signers[1].auth_mode).toBe("tokenSms");
  });

  it("WhatsApp automático fica DESLIGADO por padrão — ele é cobrado por envio", async () => {
    await zap().criarDocumento({ name: "C", url_pdf: "x", signers: [{ name: "Maria Silva" }] });
    expect(corpo().signers[0].send_automatic_whatsapp).toBe(false);

    const ligado = new ZapSignClient(
      zapsignConfigSchema.parse({ whatsappAutomatico: true }),
      "tok",
    );
    await ligado.criarDocumento({ name: "C", url_pdf: "x", signers: [{ name: "Maria Silva" }] });
    expect(corpo().signers[0].send_automatic_whatsapp).toBe(true);
  });

  it("resolve o modelo pelo nome cadastrado", () => {
    expect(resolverModelo("Contrato de Endereço Fiscal", configZap).templateId).toBe(
      "tpl-abc-123",
    );
    expect(resolverModelo("Inexistente", configZap).templateId).toBeUndefined();
    expect(resolverModelo("Inexistente", configZap).nomes).toEqual([
      "Contrato de Endereço Fiscal",
    ]);
  });

  /**
   * A mesma informação vem com nomes diferentes em endpoints diferentes.
   * Comparar sem normalizar conclui que ninguém assinou.
   */
  it("normaliza o status do signatário entre detalhe e listagem", () => {
    expect(normalizarStatusDeSignatario("signed")).toBe("assinou");
    expect(normalizarStatusDeSignatario("assinou")).toBe("assinou");
    expect(normalizarStatusDeSignatario("new")).toBe("nao_abriu");
    expect(normalizarStatusDeSignatario("nao_abriu")).toBe("nao_abriu");
    expect(normalizarStatusDeSignatario("link-opened")).toBe("abriu");
    expect(normalizarStatusDeSignatario(undefined)).toBe("desconhecido");
  });
});

// ─── ClickSign ─────────────────────────────────────────────────────────────

const configClick = clicksignConfigSchema.parse({
  baseUrl: "https://sandbox.clicksign.com/api/v3",
});

const click = () => new ClickSignClient(configClick, "tok_click");

describe("ClickSign", () => {
  it("manda o token CRU, sem Bearer", async () => {
    await click().detalharEnvelope("env-1");
    expect(headers().Authorization).toBe("tok_click");
  });

  it("usa o content-type do JSON:API", async () => {
    await click().criarEnvelope({ name: "Contrato" });
    expect(headers()["Content-Type"]).toBe("application/vnd.api+json");
  });

  it("embrulha o corpo em data.type + attributes", async () => {
    await click().criarEnvelope({ name: "Contrato de EF" });

    expect(corpo().data.type).toBe("envelopes");
    expect(corpo().data.attributes.name).toBe("Contrato de EF");
    expect(corpo().data.attributes.locale).toBe("pt-BR");
  });

  it("requisito carrega as relações de documento e signatário", async () => {
    await click().exigirAutenticacao("env-1", {
      documentId: "doc-9",
      signerId: "sig-7",
      auth: "whatsapp",
    });

    expect(corpo().data.attributes).toEqual({
      action: "provide_evidence",
      auth: "whatsapp",
    });
    expect(corpo().data.relationships.document.data).toEqual({
      type: "documents",
      id: "doc-9",
    });
    expect(corpo().data.relationships.signer.data).toEqual({
      type: "signers",
      id: "sig-7",
    });
  });

  it("ativar é PATCH com status running", async () => {
    await click().ativar("env-1");

    expect(ultima().init.method).toBe("PATCH");
    expect(corpo().data.attributes.status).toBe("running");
    expect(corpo().data.id).toBe("env-1");
  });

  /**
   * O caminho mínimo são seis requisições. Um agente fazendo passo a passo
   * estoura o teto de rodadas de tool antes de terminar — e modelo que não
   * consegue pagar o caminho certo pega o atalho errado.
   */
  it("enviarParaAssinatura percorre o fluxo inteiro, na ordem", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      chamadas.push({ url: String(url), init });
      return {
        ok: true,
        status: 201,
        json: async () => ({ data: { id: `id-${++n}`, type: "x" } }),
        text: async () => "",
      } as unknown as Response;
    });

    const r = await click().enviarParaAssinatura({
      nome: "Contrato de Endereço Fiscal",
      arquivo: { filename: "contrato.pdf", base64: "JVBERi0=" },
      signatarios: [
        { name: "Maria Silva", email: "maria@ex.com", auth: "whatsapp" },
      ],
    });

    const rotas = chamadas.map((c) => `${c.init.method ?? "GET"} ${new URL(c.url).pathname}`);
    expect(rotas).toEqual([
      "POST /api/v3/envelopes",
      "POST /api/v3/envelopes/id-1/documents",
      "POST /api/v3/envelopes/id-1/signers",
      "POST /api/v3/envelopes/id-1/requirements",
      "POST /api/v3/envelopes/id-1/requirements",
      "PATCH /api/v3/envelopes/id-1",
    ]);
    expect(r.envelopeId).toBe("id-1");
    expect(r.signatarios).toHaveLength(1);
  });

  it("envelope sem signatário nem tenta — não daria para ativar", async () => {
    await expect(
      click().enviarParaAssinatura({
        nome: "X",
        arquivo: { filename: "a.pdf", base64: "x" },
        signatarios: [],
      }),
    ).rejects.toThrow(/signatário/i);

    expect(chamadas).toEqual([]);
  });

  it("503 explica que Envelopes não está habilitado na conta", async () => {
    resposta = { status: 503, corpo: {} };

    const r = await click().testar();

    expect(r.ok).toBe(false);
    expect(r.mensagem).toContain("Envelopes");
  });

  it("prazo sai em RFC 3339, contado da referência", () => {
    const base = new Date("2026-08-01T12:00:00.000Z");
    expect(prazoDeAssinatura(15, base)).toBe("2026-08-16T12:00:00.000Z");
  });
});
