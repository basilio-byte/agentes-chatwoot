import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeituraDeSaldo } from "@/server/consumo/saldo";
import type { ClienteDeAviso } from "./conversa";

/**
 * O que a conferência não pode errar: mandar o mesmo aviso duas vezes, contar
 * como dado um aviso que não saiu, e avisar por causa de uma leitura que falhou.
 */

type Linha = Record<string, unknown>;

let linha: Linha | null;
/** O que `findUnique` devolve no lugar da linha: simula quem leu antes de outro gravar. */
let leituraAtrasada: Linha | null;
let avisos: Linha[];
let leitura: LeituraDeSaldo;
let enviados: { conversa: number; texto: string }[];
let envioFalha: boolean;

const mesmaData = (a: unknown, b: unknown) =>
  (a == null && b == null) ||
  (a instanceof Date && b instanceof Date && a.getTime() === b.getTime());

vi.mock("@/lib/db", () => ({
  db: {
    alertaDeSaldo: {
      findUnique: async () => {
        const fonte = leituraAtrasada ?? linha;
        return fonte ? { ...fonte } : null;
      },
      update: async ({ data }: { data: Linha }) => Object.assign(linha!, data),
      updateMany: async ({ where, data }: { where: Linha; data: Linha }) => {
        if (!linha || !mesmaData(linha.avisadoEm ?? null, where.avisadoEm ?? null)) {
          return { count: 0 };
        }
        Object.assign(linha, data);
        return { count: 1 };
      },
    },
    avisoDeSaldo: {
      create: async ({ data }: { data: Linha }) => {
        avisos.push({ ...data, criadoEm: new Date() });
      },
      findFirst: async () =>
        [...avisos].reverse().find((a) => a.tipo === "TESTE") ?? null,
    },
  },
}));

vi.mock("@/server/consumo/saldo", async (original) => ({
  ...(await original<typeof import("@/server/consumo/saldo")>()),
  lerSaldo: async () => leitura,
}));

vi.mock("@/server/consumo/consulta", () => ({
  DIAS_DA_MEDIA: 7,
  gastoMedioPorDia: async () => 0.8,
}));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteComTokenDeUsuario: async () => null,
}));

const { conferirSaldoEAvisar, enviarTeste, esquecerUltimaConferencia } = await import("./alerta");

const AGORA = new Date("2026-09-18T13:00:00Z");
const HORA = 60 * 60_000;
const depois = (ms: number) => new Date(AGORA.getTime() + ms);

let proximaConversa = 1000;
const cliente: ClienteDeAviso = {
  buscarContatos: async () => [],
  criarContato: async () => ({ id: 1, sourceId: "s" }),
  vincularContatoACaixa: async () => "s",
  conversasDoContato: async () => [],
  criarConversa: async () => proximaConversa++,
  enviarMensagem: async (conversa, texto) => {
    if (envioFalha) throw new Error("Chatwoot respondeu 502: Bad Gateway");
    enviados.push({ conversa, texto });
    return { id: 1 };
  },
};

const saldo = (saldoUsd: number): LeituraDeSaldo => ({
  estado: "lido",
  origem: "conta",
  saldoUsd,
  usadoUsd: 500,
  compradoUsd: 500 + saldoUsd,
  lidoEm: AGORA,
});

const conferir = (agora: Date, forcar = true) =>
  conferirSaldoEAvisar({ agora, cliente, forcar });

beforeEach(() => {
  esquecerUltimaConferencia();
  linha = {
    id: "unico",
    ligado: true,
    limiteUsd: 20,
    caixaId: 31,
    destinatarios: [
      { nome: "Pessoa Um", telefone: "+5584999991234" },
      { nome: "Pessoa Dois", telefone: "+5584988884321" },
    ],
    abaixoDesde: null,
    avisadoEm: null,
    avisadoTipo: null,
    conferidoEm: null,
    ultimaFalha: null,
  };
  leituraAtrasada = null;
  avisos = [];
  enviados = [];
  envioFalha = false;
  leitura = saldo(76.98);
});

describe("conferirSaldoEAvisar", () => {
  it("saldo bom: não manda nada, e registra que conferiu", async () => {
    expect(await conferir(AGORA)).toMatchObject({ acao: "normalizar" });
    expect(enviados).toEqual([]);
    expect(linha!.conferidoEm).toEqual(AGORA);
  });

  it("caiu abaixo do limite: avisa todo mundo uma vez e marca o episódio", async () => {
    leitura = saldo(18.42);
    await conferir(AGORA);

    expect(enviados).toHaveLength(2);
    expect(enviados[0].texto).toContain("Restam US$ 18,42");
    expect(linha).toMatchObject({ avisadoEm: AGORA, avisadoTipo: "BAIXO", abaixoDesde: AGORA });
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ tipo: "BAIXO", entregues: 2, falhas: 0, saldoUsd: 18.42 });
  });

  it("dentro das 24 h não repete; passadas as 24 h, repete", async () => {
    leitura = saldo(18);
    await conferir(AGORA);
    await conferir(depois(10 * 60_000));
    await conferir(depois(23 * HORA));
    expect(enviados).toHaveLength(2);

    await conferir(depois(24 * HORA));
    expect(enviados).toHaveLength(4);
    // O episódio é o mesmo: começou na primeira queda.
    expect(linha!.abaixoDesde).toEqual(AGORA);
  });

  it("⚠ zerou dentro das 24 h: avisa na hora", async () => {
    leitura = saldo(5);
    await conferir(AGORA);
    leitura = saldo(0);
    await conferir(depois(HORA));
    expect(enviados).toHaveLength(4);
    expect(enviados[2].texto).toContain("ZERADO");
    expect(linha!.avisadoTipo).toBe("ZERADO");
  });

  it("recarregou: o episódio acaba, e a próxima queda avisa de novo na hora", async () => {
    leitura = saldo(10);
    await conferir(AGORA);
    leitura = saldo(100);
    await conferir(depois(HORA));
    expect(linha).toMatchObject({ abaixoDesde: null, avisadoEm: null, avisadoTipo: null });

    leitura = saldo(15);
    await conferir(depois(2 * HORA));
    expect(enviados).toHaveLength(4);
  });

  it("⚠ nenhuma mensagem saiu: desfaz a reserva, e a próxima conferência tenta de novo", async () => {
    leitura = saldo(18);
    envioFalha = true;
    await conferir(AGORA);

    expect(linha!.avisadoEm).toBeNull();
    expect(String(linha!.ultimaFalha)).toContain("nenhuma mensagem saiu");
    expect(avisos[0]).toMatchObject({ entregues: 0, falhas: 2 });

    envioFalha = false;
    await conferir(depois(10 * 60_000));
    expect(enviados).toHaveLength(2);
    expect(linha!.ultimaFalha).toBeNull();
  });

  it("⚠ leitura que falha não avisa e não mexe no episódio", async () => {
    leitura = saldo(18);
    await conferir(AGORA);
    leitura = { estado: "erro", motivo: "timeout", lidoEm: AGORA };
    await conferir(depois(25 * HORA));

    expect(enviados).toHaveLength(2);
    expect(linha!.avisadoEm).toEqual(AGORA);
    expect(linha!.ultimaFalha).toBe("não consegui saber o saldo: timeout");
  });

  it("⚠ outra conferência já avisou entre a leitura e a reserva: não manda de novo", async () => {
    leitura = saldo(18);
    // Quem conferiu leu a linha sem aviso; a linha de verdade já tem um.
    leituraAtrasada = { ...linha!, avisadoEm: null };
    linha!.avisadoEm = depois(-HORA);
    linha!.abaixoDesde = depois(-HORA);

    expect(await conferir(AGORA)).toEqual({ acao: "outro já avisou" });
    expect(enviados).toEqual([]);
  });

  it("desligado não lê o saldo nem manda nada", async () => {
    linha!.ligado = false;
    leitura = saldo(1);
    expect(await conferir(AGORA)).toEqual({ acao: "desligado" });
    expect(enviados).toEqual([]);
  });

  it("confere no máximo a cada 10 minutos, mesmo chamada de minuto em minuto", async () => {
    leitura = saldo(18);
    await conferirSaldoEAvisar({ agora: AGORA, cliente });
    expect(await conferirSaldoEAvisar({ agora: depois(60_000), cliente })).toEqual({
      acao: "cedo",
    });
  });
});

describe("enviarTeste", () => {
  it("manda aos números salvos, com o saldo de agora, e registra quem mandou", async () => {
    const resultado = await enviarTeste({ id: "u1", nome: "Pessoa Admin" }, { cliente });
    expect("entregas" in resultado && resultado.entregas.every((e) => e.ok)).toBe(true);
    expect(enviados[0].texto).toContain("Mandado por Pessoa Admin pelo painel. Saldo agora: US$ 76,98.");
    expect(avisos[0]).toMatchObject({ tipo: "TESTE", autorId: "u1", entregues: 2 });
    // Teste não é aviso: o episódio fica como estava.
    expect(linha!.avisadoEm).toBeNull();
  });

  it("um clique duplo não manda dois testes", async () => {
    await enviarTeste({ id: "u1", nome: null }, { cliente });
    expect(await enviarTeste({ id: "u1", nome: null }, { cliente })).toEqual({
      erro: "Um teste acabou de sair. Espere um minuto antes de mandar outro.",
    });
    expect(enviados).toHaveLength(2);
  });

  it("sem telefone salvo, recusa em vez de fingir que testou", async () => {
    linha!.destinatarios = [];
    expect(await enviarTeste({ id: "u1", nome: null }, { cliente })).toEqual({
      erro: "Cadastre e salve pelo menos um telefone antes de testar.",
    });
  });

  it("sem o token de usuário do Chatwoot, diz o que falta", async () => {
    expect(await enviarTeste({ id: "u1", nome: null }, { cliente: null })).toMatchObject({
      erro: expect.stringContaining("token de usuário do Chatwoot"),
    });
  });
});
