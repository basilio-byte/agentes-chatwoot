import { describe, expect, it } from "vitest";
import { z } from "zod";
import { paraFerramentasOpenAI, type ToolResolvida } from "./resolve";
import { IntegrationProvider } from "@/generated/prisma/enums";

function tool(name: string, inputSchema = z.object({})): ToolResolvida {
  return {
    definicao: {
      name,
      description: `descrição de ${name}`,
      inputSchema,
      execute: async () => null,
    },
    provider: IntegrationProvider.CLICKUP,
    configuracao: { config: {}, credential: null },
  };
}

describe("conversão de tools para o formato function", () => {
  it("ordena por nome — a ordem estável preserva o cache de prefixo", () => {
    const entrada = new Map<string, ToolResolvida>([
      ["zeta_tool", tool("zeta_tool")],
      ["alfa_tool", tool("alfa_tool")],
      ["meio_tool", tool("meio_tool")],
    ]);

    expect(
      paraFerramentasOpenAI(entrada).map((t) => t.function.name),
    ).toEqual(["alfa_tool", "meio_tool", "zeta_tool"]);
  });

  it("produz a mesma saída para a mesma entrada em ordem diferente", () => {
    const a = new Map([
      ["b", tool("b")],
      ["a", tool("a")],
    ]);
    const b = new Map([
      ["a", tool("a")],
      ["b", tool("b")],
    ]);

    expect(JSON.stringify(paraFerramentasOpenAI(a))).toBe(
      JSON.stringify(paraFerramentasOpenAI(b)),
    );
  });

  it("gera o envelope `type: function` esperado pela OpenRouter", () => {
    const [ferramenta] = paraFerramentasOpenAI(
      new Map([["clickup_criar_tarefa", tool("clickup_criar_tarefa")]]),
    );

    expect(ferramenta.type).toBe("function");
    expect(ferramenta.function.name).toBe("clickup_criar_tarefa");
    expect(ferramenta.function.description).toContain("descrição de");
  });

  it("converte o schema Zod e remove o \\$schema", () => {
    const entrada = new Map([
      [
        "clickup_criar_tarefa",
        tool(
          "clickup_criar_tarefa",
          z.object({
            titulo: z.string().describe("Título da tarefa"),
            urgente: z.boolean().optional(),
          }),
        ),
      ],
    ]);

    const [ferramenta] = paraFerramentasOpenAI(entrada);
    const parametros = ferramenta.function.parameters as Record<
      string,
      unknown
    >;

    expect(parametros.$schema).toBeUndefined();
    expect(parametros.type).toBe("object");
    expect(Object.keys(parametros.properties as object)).toEqual([
      "titulo",
      "urgente",
    ]);
    expect(parametros.required).toEqual(["titulo"]);
  });

  it("mapa vazio vira lista vazia — sem tools, sem `tools` no request", () => {
    expect(paraFerramentasOpenAI(new Map())).toEqual([]);
  });
});
