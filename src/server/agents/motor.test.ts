import { describe, expect, it } from "vitest";
import { motivoDaVolta, resolverMotor, type MotorDoAgente } from "./motor";

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

  it("rede e tempo esgotado pelo nome do erro do SDK", () => {
    expect(motivoDaVolta(Object.assign(new Error("x"), { name: "APIConnectionTimeoutError" }))).toBe(
      "o proxy demorou demais para responder",
    );
    expect(motivoDaVolta(Object.assign(new Error("x"), { name: "APIConnectionError" }))).toBe(
      "não consegui falar com o proxy",
    );
  });

  it("o resto sai com o status e a mensagem, cortada", () => {
    expect(motivoDaVolta(Object.assign(new Error("schema ruim"), { status: 400 }))).toBe(
      "o proxy respondeu 400: schema ruim",
    );
    expect(motivoDaVolta(new Error("a".repeat(500))).length).toBeLessThan(230);
  });
});
