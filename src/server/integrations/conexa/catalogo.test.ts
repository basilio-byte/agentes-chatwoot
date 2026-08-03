import { describe, expect, it } from "vitest";
import { conexaIntegration } from "./index";
import { ehCobrancaPendente, formatarCobranca, semVazios } from "./formatacao";

const tools = conexaIntegration.tools;
const nomes = tools.map((t) => t.name);

/**
 * O catálogo é contrato com duas partes: com o modelo (nome e descrição) e com
 * a tela do agente (categoria e `requiresConfirmation`). Mexer nele sem passar
 * por aqui quebra uma das duas em silêncio.
 */
describe("catálogo do Conexa", () => {
  it("toda tool é prefixada, para não colidir com outra integração", () => {
    for (const nome of nomes) expect(nome.startsWith("conexa_")).toBe(true);
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

  /**
   * A tela agrupa na ordem do array. Espalhar tools da mesma categoria em
   * pontos diferentes cria dois grupos com o mesmo título.
   */
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

  /**
   * `requiresConfirmation` é o que marca "escreve" na interface. A lista fica
   * travada inteira de propósito: incluir tool nova obriga a decidir
   * conscientemente de que lado ela está.
   */
  it("exatamente estas tools escrevem no ERP", () => {
    const escrevem = tools.filter((t) => t.requiresConfirmation).map((t) => t.name);

    expect(escrevem.sort()).toEqual(
      [
        "conexa_alterar_reserva",
        "conexa_atualizar_cliente",
        "conexa_cancelar_reserva",
        "conexa_criar_cliente",
        "conexa_criar_cobranca",
        "conexa_criar_contrato",
        "conexa_criar_pessoa",
        "conexa_criar_reserva",
        "conexa_encerrar_contrato",
        "conexa_enviar_contrato_para_assinatura",
        "conexa_registrar_lead",
      ].sort(),
    );
  });

  it("nenhuma consulta pede confirmação", () => {
    const consultas = ["buscar", "ver", "listar", "pix"];
    for (const t of tools) {
      const ehConsulta = consultas.some((c) => t.name.includes(`_${c}`));
      if (ehConsulta) expect(t.requiresConfirmation, t.name).toBeFalsy();
    }
  });

  it("cobre o caminho que fecha a venda", () => {
    for (const necessaria of [
      "conexa_buscar_cliente",
      "conexa_criar_cliente",
      "conexa_listar_planos",
      "conexa_criar_contrato",
      "conexa_enviar_contrato_para_assinatura",
      "conexa_listar_cobrancas",
      "conexa_pix_da_cobranca",
    ]) {
      expect(nomes).toContain(necessaria);
    }
  });

  /**
   * Duas decisões explícitas do usuário em 31/07/2026: a IA não coleta dado de
   * cartão e não declara que o dinheiro entrou.
   */
  it("não expõe cartão de crédito nem baixa de cobrança", () => {
    expect(nomes.some((n) => n.includes("cartao") || n.includes("credit"))).toBe(false);
    expect(nomes.some((n) => n.includes("baixar") || n.includes("settle") || n.includes("quitar"))).toBe(false);
  });
});

describe("formatação", () => {
  it("pendente é `unpaid`, não `open`", () => {
    // Filtrar pelo nome errado devolveria lista vazia, e o agente diria a um
    // inadimplente que ele não deve nada.
    expect(ehCobrancaPendente("unpaid")).toBe(true);
    expect(ehCobrancaPendente("open")).toBe(false);
    expect(ehCobrancaPendente("paid")).toBe(false);
  });

  it("o valor mostrado é o ATUAL, com juros e multa", () => {
    const c = formatarCobranca({ amount: 100, currentAmount: 118.5, status: "unpaid" });

    expect(c.valorAtual).toBe(118.5);
    expect(c.valorOriginal).toBe(100);
  });

  it("sem juros, o valor atual cai para o original", () => {
    expect(formatarCobranca({ amount: 100, status: "unpaid" }).valorAtual).toBe(100);
  });

  it("campos vazios não vão para o modelo", () => {
    expect(semVazios({ a: 1, b: undefined, c: null, d: "", e: 0 })).toEqual({ a: 1, e: 0 });
  });
});
