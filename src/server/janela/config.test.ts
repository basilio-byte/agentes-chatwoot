import { describe, expect, it } from "vitest";
import { configDoFormulario, INSTRUCAO_PADRAO, lerConfigJanela } from "./config";

const formulario = (campos: Record<string, string>) => (campo: string) => campos[campo] ?? null;

describe("lerConfigJanela", () => {
  it("sem nada gravado: só a caixa 29, aviso 1 h antes, texto do n8n", () => {
    expect(lerConfigJanela({})).toEqual({
      caixas: [29],
      minutosDeAviso: 60,
      instrucao: INSTRUCAO_PADRAO,
    });
  });

  it("config mexida à mão e inválida cai nos padrões", () => {
    expect(lerConfigJanela({ caixas: "29", minutosDeAviso: 5 }).caixas).toEqual([29]);
  });
});

describe("configDoFormulario", () => {
  it("lê caixas separadas por vírgula ou espaço, sem repetir", () => {
    const lido = configDoFormulario(
      formulario({ caixas: "29, 30 29", minutosDeAviso: "90", instrucao: "Ligar." }),
    );
    expect(lido).toEqual({ config: { caixas: [29, 30], minutosDeAviso: 90, instrucao: "Ligar." } });
  });

  it("minutos em branco é recusa, não zero", () => {
    const lido = configDoFormulario(
      formulario({ caixas: "29", minutosDeAviso: "", instrucao: "Ligar." }),
    );
    expect(lido).toEqual({ erro: "Minutos de aviso (inteiro, de 15 a 240): valor inválido ou em branco." });
  });

  it("aviso menor que o intervalo da conferência é recusado", () => {
    expect("erro" in configDoFormulario(formulario({ caixas: "29", minutosDeAviso: "10", instrucao: "x" }))).toBe(true);
  });

  it("caixa que não é número é recusada", () => {
    expect(configDoFormulario(formulario({ caixas: "caixa 29", minutosDeAviso: "60", instrucao: "x" }))).toEqual({
      erro: "Caixas: informe o número de cada caixa do Chatwoot (ex.: 29), separados por vírgula.",
    });
  });
});
