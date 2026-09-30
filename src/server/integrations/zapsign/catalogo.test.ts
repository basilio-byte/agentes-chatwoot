import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationProvider } from "@/generated/prisma/enums";
import { situacaoDoDocumento, zapsignIntegration } from "./index";

const tools = zapsignIntegration.tools;
const nomes = tools.map((t) => t.name);

describe("catálogo da ZapSign", () => {
  it("toda tool é prefixada", () => {
    for (const n of nomes) expect(n.startsWith("zapsign_")).toBe(true);
  });

  it("não há nome repetido", () => {
    expect(new Set(nomes).size).toBe(nomes.length);
  });

  it("toda tool tem categoria e descrição prescritiva", () => {
    for (const t of tools) {
      expect(t.categoria, t.name).toBeTruthy();
      expect(t.description.length, t.name).toBeGreaterThan(40);
    }
  });

  it("categorias ficam contíguas no array", () => {
    const vistas = new Set<string>();
    let anterior = "";
    for (const t of tools) {
      const c = String(t.categoria);
      if (c !== anterior) {
        expect(vistas.has(c), `categoria "${c}" aparece em dois blocos`).toBe(false);
        vistas.add(c);
        anterior = c;
      }
    }
  });

  it("exatamente estas tools escrevem na ZapSign", () => {
    const escrevem = tools.filter((t) => t.requiresConfirmation).map((t) => t.name);

    expect(escrevem.sort()).toEqual(
      [
        "zapsign_adicionar_signatario",
        "zapsign_cancelar_documento",
        "zapsign_corrigir_signatario",
        "zapsign_criar_documento_de_arquivo",
        "zapsign_gerar_contrato",
      ].sort(),
    );
  });

  it("nenhuma consulta pede confirmação", () => {
    for (const t of tools) {
      if (/_(listar|ver)_/.test(t.name)) {
        expect(t.requiresConfirmation, t.name).toBeFalsy();
      }
    }
  });

  /**
   * O caminho que o usuário pediu: achar o modelo, descobrir os campos,
   * preencher, gerar e receber o link. Cada passo tem de existir.
   */
  it("cobre o caminho do contrato de ponta a ponta", () => {
    for (const necessaria of [
      "zapsign_listar_modelos",
      "zapsign_ver_modelo",
      "zapsign_gerar_contrato",
      "zapsign_ver_documento",
    ]) {
      expect(nomes).toContain(necessaria);
    }
  });

  /**
   * Excluir documento existe na API e ficou de fora: é irreversível pela
   * interface e não resolve nada que cancelar não resolva. Se voltar, que seja
   * por decisão, não por descuido.
   */
  it("não expõe exclusão de documento", () => {
    expect(nomes.some((n) => n.includes("excluir"))).toBe(false);
  });
});

describe("marca de ambiente nas respostas", () => {
  /**
   * Em sandbox o documento não tem validade jurídica, e nada na resposta da
   * ZapSign diz isso. Sem a marca, o agente geraria um contrato de teste,
   * mandaria o link ao cliente com toda a confiança, e a execução não guardaria
   * pista nenhuma de que aquilo não valia nada.
   */
  const ctx = (ambiente: "producao" | "sandbox") => ({
    provider: IntegrationProvider.ZAPSIGN,
    config: { ambiente, modelos: [{ nome: "Contrato", templateId: "tpl-1" }] },
    credential: "tok",
    agentId: "a1",
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        token: "doc-1",
        name: "Contrato",
        status: "pending",
        signers: [{ token: "s1", sign_url: "https://x", name: "Maria", status: "new" }],
      }),
      text: async () => "",
    }));
  });

  const verDocumento = tools.find((t) => t.name === "zapsign_ver_documento")!;

  it("sandbox marca a resposta e avisa que não vale como contrato", async () => {
    const r = (await verDocumento.execute(
      { documentoId: "doc-1234567890" },
      ctx("sandbox"),
    )) as Record<string, unknown>;

    expect(r.ambiente).toBe("sandbox");
    expect(String(r.avisoImportante)).toContain("NÃO tem validade jurídica");
  });

  it("produção marca sem aviso — não há o que ressalvar", async () => {
    const r = (await verDocumento.execute(
      { documentoId: "doc-1234567890" },
      ctx("producao"),
    )) as Record<string, unknown>;

    expect(r.ambiente).toBe("producao");
    expect(r.avisoImportante).toBeUndefined();
  });
});

describe("documento excluído na ZapSign", () => {
  /**
   * Excluir na ZapSign manda para a lixeira com `deleted: true` e deixa o
   * `status` como estava. Repassando só o status, o agente de contratos via
   * "pendente" um contrato que a equipe tinha excluído para liberar a geração
   * do certo, e recusava gerar (30/09/2026).
   */
  const ctx = {
    provider: IntegrationProvider.ZAPSIGN,
    config: { ambiente: "producao", modelos: [] },
    credential: "tok",
    agentId: "a1",
  };

  function responder(corpo: unknown) {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => corpo,
      text: async () => "",
    }));
  }

  const excluido = {
    token: "doc-1",
    name: "EV LITORAL PJ",
    status: "pending",
    deleted: true,
    deleted_at: "2026-09-30T19:19:33Z",
    signers: [],
  };

  it("situacaoDoDocumento: excluído vence o status", () => {
    expect(situacaoDoDocumento({ status: "pending", deleted: true })).toBe("excluido");
    expect(situacaoDoDocumento({ status: "signed", deleted: true })).toBe("excluido");
    expect(situacaoDoDocumento({ status: "pending", deleted: false })).toBe("pending");
    expect(situacaoDoDocumento({ status: "signed" })).toBe("signed");
  });

  it("ver_documento devolve 'excluido' e quando foi, nunca 'pending'", async () => {
    responder(excluido);
    const ver = tools.find((t) => t.name === "zapsign_ver_documento")!;
    const r = (await ver.execute({ documentoId: "doc-1234567890" }, ctx)) as Record<string, unknown>;

    expect(r.status).toBe("excluido");
    expect(r.excluidoEm).toBe("2026-09-30T19:19:33Z");
  });

  it("listar_documentos marca o excluído", async () => {
    responder({ count: 2, next: null, results: [excluido, { ...excluido, token: "doc-2", deleted: false }] });
    const listar = tools.find((t) => t.name === "zapsign_listar_documentos")!;
    const r = (await listar.execute({}, ctx)) as { documentos: { documentoId: string; status: string }[] };

    expect(r.documentos).toEqual([
      { documentoId: "doc-1", nome: "EV LITORAL PJ", status: "excluido" },
      { documentoId: "doc-2", nome: "EV LITORAL PJ", status: "pending" },
    ]);
  });

  it("as duas descrições dizem ao modelo o que 'excluido' significa", () => {
    for (const n of ["zapsign_ver_documento", "zapsign_listar_documentos"]) {
      expect(tools.find((t) => t.name === n)!.description).toContain('"excluido"');
    }
  });
});
