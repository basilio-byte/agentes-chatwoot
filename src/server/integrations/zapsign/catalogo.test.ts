import { describe, expect, it } from "vitest";
import { zapsignIntegration } from "./index";

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
