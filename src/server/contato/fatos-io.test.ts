import { beforeEach, describe, expect, it, vi } from "vitest";

let chamadas: { toolName: string; input: unknown; output: unknown }[] = [];
let consulta: unknown;
let cadastro: Record<string, unknown> = {};
let leituras: number[] = [];
let conexaAberto: unknown;

vi.mock("@/lib/db", () => ({
  db: {
    toolCall: {
      findMany: async (q: unknown) => {
        consulta = q;
        return chamadas;
      },
    },
  },
}));
vi.mock("@/server/integrations/conexa/sistema", () => ({
  abrirConexa: async () =>
    conexaAberto ?? {
      cliente: {
        obterCliente: async (id: number) => {
          leituras.push(id);
          return cadastro;
        },
      },
    },
}));

import { fatosDoClienteDaConversa } from "./fatos";

beforeEach(() => {
  chamadas = [];
  consulta = undefined;
  leituras = [];
  conexaAberto = undefined;
  cadastro = {
    customerId: 77,
    name: "Maria da Silva",
    naturalPerson: { cpf: "045.789.994-83" },
    emailsMessage: ["Maria@Exemplo.com"],
    cellNumber: "+55 84 99999-9999",
  };
});

describe("fatosDoClienteDaConversa", () => {
  it("lê o cliente que um agente já usou na conversa e devolve os dados do cadastro", async () => {
    chamadas = [
      { toolName: "conexa_criar_reserva", input: { clienteId: 77 }, output: { criada: true, reserva: { sala: "Sala 03 - Seahub", cliente: 77 } } },
    ];

    const f = await fatosDoClienteDaConversa("conversa-1");

    expect(leituras).toEqual([77]);
    expect(f).toEqual({
      nome: "Maria da Silva",
      cpf: "04578999483",
      email: "maria@exemplo.com",
      celular: "+55 84 99999-9999",
      sala: "Sala 03 - Seahub",
    });
    expect((consulta as { where: { run: unknown } }).where.run).toEqual({ conversationId: "conversa-1" });
  });

  it("⚠ sem cliente nas chamadas, não procura ninguém por nome: devolve só o que a reserva diz", async () => {
    chamadas = [{ toolName: "conexa_listar_reservas", input: {}, output: {} }];
    expect(await fatosDoClienteDaConversa("conversa-1")).toEqual({});
    expect(leituras).toEqual([]);
  });

  it("cliente recém-criado vem da saída de conexa_criar_cliente", async () => {
    chamadas = [{ toolName: "conexa_criar_cliente", input: { nome: "x" }, output: { criado: true, clienteId: 77 } }];
    expect((await fatosDoClienteDaConversa("c")).cpf).toBe("04578999483");
  });

  it("Conexa desligado: segue com a sala, sem lançar", async () => {
    conexaAberto = { erro: "a integração do Conexa está desligada" };
    chamadas = [{ toolName: "conexa_criar_reserva", input: { clienteId: 77 }, output: { reserva: { sala: "Sala 01", cliente: 77 } } }];
    expect(await fatosDoClienteDaConversa("c")).toEqual({ sala: "Sala 01" });
  });

  it("sem conversa, não consulta nada", async () => {
    expect(await fatosDoClienteDaConversa(undefined)).toEqual({});
    expect(consulta).toBeUndefined();
  });
});
