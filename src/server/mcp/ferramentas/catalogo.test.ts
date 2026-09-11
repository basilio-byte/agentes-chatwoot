import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { UserRole } from "@/generated/prisma/enums";
import { CATALOGO } from "./index";

// O catálogo importa os serviços, que importam o banco e o cache do Next. Nada
// disso roda aqui: o teste lê só a FORMA das ferramentas.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

function porNome(nome: string) {
  const f = CATALOGO.find((x) => x.name === nome);
  if (!f) throw new Error(`ferramenta ${nome} sumiu do catálogo`);
  return f;
}

describe("catálogo de ferramentas do MCP", () => {
  it("nomes únicos, em snake_case", () => {
    const nomes = CATALOGO.map((f) => f.name);
    expect(new Set(nomes).size).toBe(nomes.length);
    for (const nome of nomes) expect(nome).toMatch(/^[a-z]+(_[a-z]+)+$/);
  });

  it("nada do que é só do painel: excluir, credencial, token, contas", () => {
    // Fica fora do servidor inteiro, qualquer que seja o papel do dono do token.
    // Acrescentar uma ferramenta assim exige mudar este teste de propósito.
    for (const f of CATALOGO) {
      expect(f.name).not.toMatch(
        /excluir|apagar|remover|deletar|credencial|senha|token|usuario|conta/,
      );
    }
  });

  it("nenhuma ferramenta exige Proprietário — o MCP não carrega poder de dono", () => {
    for (const f of CATALOGO) expect(f.papel, f.name).not.toBe(UserRole.OWNER);
  });

  it("o que a Leitura enxerga é só consulta", () => {
    for (const f of CATALOGO.filter((x) => x.papel === UserRole.VIEWER)) {
      expect(f.anotacoes.readOnlyHint, f.name).toBe(true);
    }
  });

  it("o que altera exige Administrador", () => {
    for (const f of CATALOGO.filter((x) => !x.anotacoes.readOnlyHint)) {
      expect(f.papel, f.name).toBe(UserRole.ADMIN);
    }
  });

  it("toda entrada recusa parâmetro desconhecido", () => {
    // É a lição do CRM: nome errado aceito em silêncio vira ação pela metade.
    for (const f of CATALOGO) {
      const esquema = z.toJSONSchema(f.entrada, { io: "input" }) as Record<string, unknown>;
      expect(esquema.additionalProperties, f.name).toBe(false);
    }
  });

  it("descrições dizem o que a ferramenta faz", () => {
    for (const f of CATALOGO) {
      expect(f.description.length, f.name).toBeGreaterThan(60);
      expect(f.title.length, f.name).toBeGreaterThan(3);
    }
  });

  it("aplicar prompt exige os dois carimbos da proposta", () => {
    const aplicar = porNome("aplicar_alteracao_de_prompt").entrada;
    const base = { agente: "suporte", novoPrompt: "x".repeat(30), baseHash: "0123456789abcdef" };
    expect(aplicar.safeParse(base).success).toBe(false);
    expect(
      aplicar.safeParse({ ...base, hashDaProposta: "fedcba9876543210" }).success,
    ).toBe(true);
  });

  it("propor e aplicar aceitam exatamente um modo de alteração", () => {
    const propor = porNome("propor_alteracao_de_prompt").entrada;
    const prompt = "x".repeat(30);
    const trocas = [{ trecho: "a", por: "b" }];
    expect(propor.safeParse({ agente: "s" }).success).toBe(false);
    expect(propor.safeParse({ agente: "s", novoPrompt: prompt, substituicoes: trocas }).success).toBe(false);
    expect(propor.safeParse({ agente: "s", substituicoes: trocas }).success).toBe(true);
  });

  it('definir ferramentas não aceita lista vazia (no banco, vazio é "todas")', () => {
    const definir = porNome("definir_ferramentas_do_agente").entrada;
    expect(definir.safeParse({ agente: "s", provider: "CLICKUP", ferramentas: [] }).success).toBe(false);
    expect(definir.safeParse({ agente: "s", provider: "CLICKUP", ferramentas: "todas" }).success).toBe(true);
  });

  it("alteração parcial sem nenhum campo é recusada", () => {
    expect(porNome("atualizar_agente").entrada.safeParse({ agente: "s" }).success).toBe(false);
    expect(porNome("definir_escopo_do_agente").entrada.safeParse({ agente: "s" }).success).toBe(false);
  });
});
