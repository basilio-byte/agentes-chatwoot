import { describe, expect, it } from "vitest";
import { z } from "zod";
import { clickupIntegration } from "./index";

/**
 * O catálogo é o que a tela do agente mostra e o que vai para o modelo. Estes
 * testes travam as invariantes que quebram silenciosamente: nome duplicado
 * some do mapa de tools, categoria faltando cai num grupo "Geral" solto, e
 * schema que o `z.toJSONSchema` não converte só estoura na hora da chamada.
 */

const tools = clickupIntegration.tools;

describe("catálogo do ClickUp", () => {
  it("todo nome é único e prefixado pelo provider", () => {
    const nomes = tools.map((t) => t.name);

    expect(new Set(nomes).size).toBe(nomes.length);
    expect(nomes.every((n) => n.startsWith("clickup_"))).toBe(true);
  });

  it("toda tool tem categoria e descrição prescritiva", () => {
    for (const tool of tools) {
      expect(tool.categoria, tool.name).toBeTruthy();
      // Descrição curta demais não ensina o modelo a escolher.
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
    }
  });

  it("cobre as categorias da listagem, sem grupo órfão", () => {
    const categorias = [...new Set(tools.map((t) => t.categoria))];

    expect(categorias).toEqual([
      "Tarefas",
      "Listas",
      "Espaços e pastas",
      "Comentários",
      "Tags",
      "Checklists",
      "Registro de tempo",
      "Relacionamentos entre tarefas",
      "Campos personalizados",
      "Membros",
    ]);
  });

  it("as tools de uma categoria ficam juntas — a UI agrupa na ordem do catálogo", () => {
    const sequencia = tools.map((t) => t.categoria);
    const primeiraOcorrencia = [...new Set(sequencia)];

    // Se uma categoria reaparecer depois de outra ter começado, a UI cria
    // dois grupos com o mesmo título.
    expect(sequencia).toEqual(
      primeiraOcorrencia.flatMap((c) => sequencia.filter((s) => s === c)),
    );
  });

  it("tudo que altera o ClickUp está marcado como escrita", () => {
    const escrevem = tools
      .filter((t) => t.requiresConfirmation)
      .map((t) => t.name)
      .sort();

    // Comentar é escrita, mas registrar o que o cliente disse é rotina do
    // atendimento — fica de fora de propósito, como já era antes.
    expect(escrevem).toEqual([
      "clickup_adicionar_item_checklist",
      "clickup_adicionar_tag",
      "clickup_atribuir_responsavel",
      "clickup_atualizar_item_checklist",
      "clickup_atualizar_tarefa",
      "clickup_criar_checklist",
      "clickup_criar_lista",
      "clickup_criar_pasta",
      "clickup_criar_tarefa",
      "clickup_definir_campo_personalizado",
      "clickup_definir_dependencia",
      "clickup_editar_comentario",
      "clickup_excluir_comentario",
      "clickup_excluir_item_checklist",
      "clickup_excluir_tarefa",
      "clickup_iniciar_cronometro",
      "clickup_mudar_status",
      "clickup_parar_cronometro",
      "clickup_registrar_tempo",
      "clickup_remover_tag",
      "clickup_vincular_tarefas",
    ]);
  });

  it("nenhuma consulta está marcada como escrita", () => {
    const consultas = tools.filter((t) => t.name.includes("listar") || t.name.includes("buscar") || t.name.includes("obter"));

    expect(consultas.length).toBeGreaterThan(5);
    for (const tool of consultas) {
      expect(tool.requiresConfirmation, tool.name).toBeFalsy();
    }
  });

  it("todo inputSchema vira JSON Schema — senão só estoura na hora da chamada", () => {
    for (const tool of tools) {
      const gerado = () =>
        z.toJSONSchema(tool.inputSchema, { io: "input" }) as Record<string, unknown>;

      expect(gerado, tool.name).not.toThrow();
      expect(gerado().type, tool.name).toBe("object");
    }
  });
});
