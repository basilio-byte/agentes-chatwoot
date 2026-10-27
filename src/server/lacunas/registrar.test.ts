import { beforeEach, describe, expect, it, vi } from "vitest";
import { TipoDeLacuna } from "@/generated/prisma/enums";

type Linha = Record<string, unknown>;

let linhas: Linha[];
let falharAoGravar: boolean;

vi.mock("@/lib/db", () => ({
  db: {
    lacunaDoAgente: {
      findFirst: async ({ where }: { where: { runId: string } }) =>
        linhas.find((l) => l.runId === where.runId) ?? null,
      create: async ({ data }: { data: Linha }) => {
        if (falharAoGravar) throw new Error("banco fora do ar");
        linhas.push(data);
        return data;
      },
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { registrarLacuna } from "./registrar";

const base = {
  agentId: "salas",
  runId: "run-1",
  chatwootConversationId: 55,
  motivo: "Cliente quer sala para 20 pessoas",
};

beforeEach(() => {
  linhas = [];
  falharAoGravar = false;
});

describe("registrarLacuna", () => {
  it("grava a lacuna com o tipo da causa", async () => {
    const gravou = await registrarLacuna({
      ...base,
      causa: "falta_de_instrucao",
      oQueFaltou: "Não há preço de sala para 20 pessoas",
    });

    expect(gravou).toBe(true);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      agentId: "salas",
      runId: "run-1",
      chatwootConversationId: 55,
      tipo: TipoDeLacuna.FALTA_INSTRUCAO,
      oQueFaltou: "Não há preço de sala para 20 pessoas",
    });
  });

  it("pedido do cliente não grava nada", async () => {
    const gravou = await registrarLacuna({ ...base, causa: "pedido_do_cliente" });

    expect(gravou).toBe(false);
    expect(linhas).toHaveLength(0);
  });

  it("uma lacuna por execução: a segunda chamada do mesmo turno não duplica", async () => {
    await registrarLacuna({ ...base, causa: "nao_entendi", oQueFaltou: "pedido confuso do cliente" });
    const segunda = await registrarLacuna({
      ...base,
      causa: "nao_entendi",
      oQueFaltou: "pedido confuso do cliente",
    });

    expect(segunda).toBe(false);
    expect(linhas).toHaveLength(1);
  });

  it("execuções diferentes da mesma conversa são lacunas diferentes", async () => {
    await registrarLacuna({ ...base, causa: "nao_entendi", oQueFaltou: "primeira dúvida do cliente" });
    await registrarLacuna({
      ...base,
      runId: "run-2",
      causa: "falta_de_ferramenta",
      oQueFaltou: "não consigo consultar o contrato",
    });

    expect(linhas).toHaveLength(2);
  });

  it("sem runId grava sempre — não há como reconhecer a repetição", async () => {
    const semRun = { ...base, runId: undefined };
    await registrarLacuna({ ...semRun, causa: "nao_entendi", oQueFaltou: "dúvida do cliente 1" });
    await registrarLacuna({ ...semRun, causa: "nao_entendi", oQueFaltou: "dúvida do cliente 2" });

    expect(linhas).toHaveLength(2);
    expect(linhas[0]?.runId).toBeNull();
  });

  it("NUNCA lança: o banco fora do ar não pode derrubar a transferência", async () => {
    falharAoGravar = true;

    await expect(
      registrarLacuna({ ...base, causa: "falta_de_ferramenta", oQueFaltou: "consultar estoque" }),
    ).resolves.toBe(false);
  });

  it("oculta e-mail e número longo, mesmo que o agente os tenha escrito", async () => {
    await registrarLacuna({
      ...base,
      motivo: "Cliente maria@exemplo.com pediu nota fiscal",
      causa: "falta_de_ferramenta",
      oQueFaltou: "emitir 2ª via para o CPF 123.456.789-00 e o telefone (84) 99999-0000",
    });

    expect(linhas[0]?.motivo).toBe("Cliente [e-mail] pediu nota fiscal");
    expect(linhas[0]?.oQueFaltou).toBe(
      "emitir 2ª via para o CPF [número] e o telefone [número]",
    );
  });

  it("limpa e corta o texto que o agente escreveu", async () => {
    await registrarLacuna({
      ...base,
      causa: "falta_de_instrucao",
      oQueFaltou: `linha um\n\nlinha dois ${"x".repeat(900)}`,
    });

    const guardado = String(linhas[0]?.oQueFaltou);
    expect(guardado).not.toContain("\n");
    expect(guardado.length).toBeLessThanOrEqual(600);
    expect(guardado.endsWith("…")).toBe(true);
  });
});
