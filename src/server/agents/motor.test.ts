import { APIConnectionError, APIConnectionTimeoutError } from "openai";
import { describe, expect, it } from "vitest";
import { RunSource } from "@/generated/prisma/enums";
import {
  motivoDaVolta,
  prazoDaIdaAoProxy,
  PRAZO_DO_PROXY_COM_ALGUEM_ESPERANDO_MS,
  PRAZO_DO_PROXY_EM_SEGUNDO_PLANO_MS,
  resolverMotor,
  semPedidosRepetidos,
  type MotorDoAgente,
} from "./motor";

/**
 * 19/11/2026: o agente de contratos de Sala Privativa, acionado pelo ClickUp,
 * foi cortado em 4 de 5 tentativas porque o Claude raciocinava mais de 2 min no
 * 1º passo. Onde ninguém espera, o teto do atendimento não faz sentido.
 */
describe("prazoDaIdaAoProxy", () => {
  it("⚠ com alguém esperando, continua o teto de 120 s (o vigia escala em 3 min)", () => {
    expect(PRAZO_DO_PROXY_COM_ALGUEM_ESPERANDO_MS).toBe(120_000);
    for (const origem of [RunSource.CHATWOOT, RunSource.PLAYGROUND, RunSource.MESA, RunSource.INTERNO]) {
      expect(prazoDaIdaAoProxy(origem)).toBe(120_000);
    }
  });

  it("em segundo plano, o Claude tem tempo de terminar de pensar", () => {
    for (const origem of [
      RunSource.TRIGGER,
      RunSource.SCHEDULE,
      RunSource.CONVERSA_ENCERRADA,
      RunSource.CONVERSA_MARCADA,
      RunSource.CONVERSA_PARADA,
    ]) {
      expect(prazoDaIdaAoProxy(origem)).toBe(PRAZO_DO_PROXY_EM_SEGUNDO_PLANO_MS);
    }
    // Acima dos ~125 s medidos no 1º passo. ⚠ E NÃO acima de 300 s: o fetch do
    // Node (undici) desiste de uma resposta sem cabeçalho em 300 s
    // (headersTimeout), antes do nosso teto e dos 10 min do proxy. Subir isto
    // sem trocar o dispatcher do cliente não daria um segundo a mais.
    expect(PRAZO_DO_PROXY_EM_SEGUNDO_PLANO_MS).toBeGreaterThan(180_000);
    expect(PRAZO_DO_PROXY_EM_SEGUNDO_PLANO_MS).toBeLessThanOrEqual(300_000);
  });

  it("toda origem tem prazo (origem nova não cai em undefined)", () => {
    for (const origem of Object.values(RunSource)) {
      expect(prazoDaIdaAoProxy(origem)).toBeGreaterThan(0);
    }
  });
});

const resolver = (
  motorDoAgente: MotorDoAgente,
  extra: Partial<{ chaveGeralLigada: boolean; proxyConfigurado: boolean; modeloDoAgente: string | null }> = {},
) =>
  resolverMotor({
    motorDoAgente,
    modeloDoAgente: null,
    chaveGeralLigada: false,
    modeloPadrao: "claude-sonnet-5",
    proxyConfigurado: true,
    ...extra,
  });

describe("resolverMotor", () => {
  it("⚠ chave geral desligada e agente no padrão: a OpenRouter de sempre", () => {
    expect(resolver("PADRAO")).toMatchObject({ motor: "OPENROUTER", modeloClaude: null });
  });

  it("chave geral ligada: quem segue o padrão vai para o Claude MAX, com o modelo padrão", () => {
    expect(resolver("PADRAO", { chaveGeralLigada: true })).toMatchObject({
      motor: "CLAUDE_MAX",
      modeloClaude: "claude-sonnet-5",
    });
  });

  it("agente fixado vence a chave geral, nos dois sentidos", () => {
    expect(resolver("OPENROUTER", { chaveGeralLigada: true }).motor).toBe("OPENROUTER");
    expect(resolver("CLAUDE_MAX", { chaveGeralLigada: false }).motor).toBe("CLAUDE_MAX");
  });

  it("o modelo do agente vence o padrão; vazio cai no padrão", () => {
    expect(resolver("CLAUDE_MAX", { modeloDoAgente: "claude-haiku-4-5" }).modeloClaude).toBe("claude-haiku-4-5");
    expect(resolver("CLAUDE_MAX", { modeloDoAgente: "  " }).modeloClaude).toBe("claude-sonnet-5");
  });

  it("⚠ proxy não configurado: OpenRouter sempre, mesmo fixado ou com a chave ligada", () => {
    expect(resolver("CLAUDE_MAX", { proxyConfigurado: false }).motor).toBe("OPENROUTER");
    expect(resolver("PADRAO", { proxyConfigurado: false, chaveGeralLigada: true }).motor).toBe("OPENROUTER");
    expect(resolver("CLAUDE_MAX", { proxyConfigurado: false }).porque).toContain("não está configurado");
  });
});

describe("motivoDaVolta", () => {
  const erro = (status: number) => Object.assign(new Error("x"), { status });

  it("traduz os códigos que o proxy devolve", () => {
    expect(motivoDaVolta(erro(429))).toContain("cota da assinatura");
    expect(motivoDaVolta(erro(401))).toContain("login da assinatura");
    expect(motivoDaVolta(erro(503))).toContain("fila do proxy");
    expect(motivoDaVolta(erro(504))).toContain("tempo do turno");
  });

  it("⚠ rede e tempo esgotado pelo erro DE VERDADE do SDK, que não tem `name`", () => {
    // Era assim que a volta de 19/11 chegou: classe certa, `name` = "Error".
    const tempo = new APIConnectionTimeoutError();
    expect(tempo.name).not.toBe("APIConnectionTimeoutError");
    expect(motivoDaVolta(tempo)).toBe("o proxy demorou demais para responder");
    expect(motivoDaVolta(new APIConnectionError({ message: undefined }))).toBe("não consegui falar com o proxy");
  });

  it("o nome e a mensagem padrão do SDK ficam de reserva", () => {
    expect(motivoDaVolta(Object.assign(new Error("x"), { name: "APIConnectionTimeoutError" }))).toBe(
      "o proxy demorou demais para responder",
    );
    expect(motivoDaVolta(new Error("Request timed out."))).toBe("o proxy demorou demais para responder");
    expect(motivoDaVolta(new Error("Connection error."))).toBe("não consegui falar com o proxy");
  });

  it("o resto sai com o status e a mensagem, cortada", () => {
    expect(motivoDaVolta(Object.assign(new Error("schema ruim"), { status: 400 }))).toBe(
      "o proxy respondeu 400: schema ruim",
    );
    expect(motivoDaVolta(new Error("a".repeat(500))).length).toBeLessThan(230);
  });
});

describe("semPedidosRepetidos", () => {
  const pedido = (id: string, name: string, args: unknown) => ({
    id,
    type: "function" as const,
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  });

  it("⚠ o mesmo pedido duas vezes (o que o proxy devolveu) vira um", () => {
    const pedidos = [
      pedido("a", "documento_conferir_cpf", { cpf: "529.982.247-25" }),
      pedido("b", "documento_conferir_cpf", { cpf: "529.982.247-25" }),
    ];
    expect(semPedidosRepetidos(pedidos).map((p) => p.id)).toEqual(["a"]);
  });

  it("a ordem das chaves não disfarça a repetição", () => {
    const pedidos = [pedido("a", "t", { x: 1, y: 2 }), pedido("b", "t", '{"y":2,"x":1}')];
    expect(semPedidosRepetidos(pedidos)).toHaveLength(1);
  });

  it("pedidos diferentes, ou a mesma ferramenta com outros argumentos, ficam", () => {
    const pedidos = [
      pedido("a", "documento_conferir_cpf", { cpf: "1" }),
      pedido("b", "documento_conferir_cpf", { cpf: "2" }),
      pedido("c", "documento_conferir_cnpj", { cnpj: "1" }),
    ];
    expect(semPedidosRepetidos(pedidos)).toHaveLength(3);
  });

  it("argumento que não é JSON compara pelo texto", () => {
    expect(semPedidosRepetidos([pedido("a", "t", "{quebrado"), pedido("b", "t", "{quebrado")])).toHaveLength(1);
  });
});
