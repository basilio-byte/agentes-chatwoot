import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { UserRole } from "@/generated/prisma/enums";
import { criarExecutor, ferramenta, type ContextoMcp } from "./executor";

const executouEscrita = vi.fn();

const catalogo = [
  ferramenta({
    name: "mudar_coisa",
    title: "Mudar coisa",
    description: "Muda uma coisa.",
    papel: UserRole.ADMIN,
    anotacoes: { readOnlyHint: false },
    entrada: z.strictObject({ ligar: z.boolean() }),
    executar: async ({ ligar }) => {
      executouEscrita(ligar);
      return { texto: "mudou" };
    },
  }),
  ferramenta({
    name: "ler_coisa",
    title: "Ler coisa",
    description: "Lê uma coisa.",
    papel: UserRole.VIEWER,
    anotacoes: { readOnlyHint: true },
    entrada: z.strictObject({ id: z.string(), limite: z.number().optional() }),
    executar: async ({ id }) => ({ texto: `leu ${id}` }),
  }),
  ferramenta({
    name: "quebrar",
    title: "Quebrar",
    description: "Sempre falha.",
    papel: UserRole.VIEWER,
    anotacoes: { readOnlyHint: true },
    entrada: z.strictObject({}),
    executar: async () => {
      throw new Error("detalhe interno do banco: senha=xyz");
    },
  }),
];

function ctx(papel: UserRole): ContextoMcp {
  return {
    tokenId: "tok",
    usuario: { id: "u1", nome: "Fulana", email: "f@x", papel },
    baseUrl: "http://localhost:3000",
  };
}

describe("executor do MCP", () => {
  it("Leitura só vê o que alcança, em ordem de nome", () => {
    const nomes = criarExecutor(catalogo, ctx(UserRole.VIEWER))
      .listar()
      .map((f) => f.name);
    expect(nomes).toEqual(["ler_coisa", "quebrar"]);
  });

  it("Administrador vê tudo", () => {
    expect(criarExecutor(catalogo, ctx(UserRole.ADMIN)).listar()).toHaveLength(3);
  });

  it("o schema publicado declara que parâmetro extra não é aceito", () => {
    const [ler] = criarExecutor(catalogo, ctx(UserRole.VIEWER)).listar();
    expect(ler.inputSchema).not.toHaveProperty("$schema");
    expect(ler.inputSchema.additionalProperties).toBe(false);
  });

  it("Leitura chamando escrita pelo nome é recusada ANTES de executar", async () => {
    executouEscrita.mockClear();
    const r = await criarExecutor(catalogo, ctx(UserRole.VIEWER)).chamar("mudar_coisa", { ligar: true });
    expect(r?.erro).toBe(true);
    expect(r?.texto).toMatch(/Administrador/);
    expect(executouEscrita).not.toHaveBeenCalled();
  });

  it("parâmetro com nome errado é recusado, nomeado e com os aceitos ao lado", async () => {
    // O defeito do CRM: `custom_fields` no lugar do nome certo passava calado.
    const r = await criarExecutor(catalogo, ctx(UserRole.VIEWER)).chamar("ler_coisa", {
      id: "1",
      custom_fields: [],
    });
    expect(r?.erro).toBe(true);
    expect(r?.texto).toMatch(/Parâmetro desconhecido: custom_fields/);
    expect(r?.texto).toMatch(/Parâmetros aceitos: id, limite/);
  });

  it("parâmetro obrigatório esquecido é dito com todas as letras", async () => {
    const r = await criarExecutor(catalogo, ctx(UserRole.VIEWER)).chamar("ler_coisa", {});
    expect(r?.erro).toBe(true);
    expect(r?.texto).toMatch(/id: obrigatório, e não foi enviado/);
  });

  it("falha inesperada devolve um código e não vaza a mensagem interna", async () => {
    const r = await criarExecutor(catalogo, ctx(UserRole.VIEWER)).chamar("quebrar", {});
    expect(r?.erro).toBe(true);
    expect(r?.texto).toMatch(/código [0-9a-f]{8}/);
    expect(r?.texto).not.toMatch(/senha|banco/);
  });

  it("ferramenta que não existe é null (erro de protocolo, não de execução)", async () => {
    expect(await criarExecutor(catalogo, ctx(UserRole.OWNER)).chamar("excluir_tudo", {})).toBeNull();
  });

  it("Administrador executa com os argumentos já validados", async () => {
    executouEscrita.mockClear();
    const r = await criarExecutor(catalogo, ctx(UserRole.ADMIN)).chamar("mudar_coisa", { ligar: false });
    expect(r).toEqual({ texto: "mudou" });
    expect(executouEscrita).toHaveBeenCalledWith(false);
  });
});
