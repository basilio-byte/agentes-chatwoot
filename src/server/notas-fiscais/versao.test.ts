import { describe, expect, it } from "vitest";
import { lerConfigNotasFiscais } from "./config";
import { versaoDaConfig } from "./versao";

describe("a versão da configuração das notas fiscais", () => {
  it("é estável: o mesmo JSON dá sempre a mesma versão, com 16 caracteres hexadecimais", () => {
    const config = { emissao: { ligada: true, codigosEmEspera: ["10.05.01"] } };
    expect(versaoDaConfig(config)).toBe(versaoDaConfig(structuredClone(config)));
    expect(versaoDaConfig(config)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("⚠ a ordem das chaves não conta (o jsonb do Postgres as devolve em outra ordem)", () => {
    expect(versaoDaConfig({ a: 1, b: { x: 1, y: [1, 2] } })).toBe(versaoDaConfig({ b: { y: [1, 2], x: 1 }, a: 1 }));
  });

  it("⚠ a ordem de uma LISTA conta: é outra configuração", () => {
    expect(versaoDaConfig({ lista: [1, 2] })).not.toBe(versaoDaConfig({ lista: [2, 1] }));
  });

  it.each([
    ["a emissão que o sistema desligou sozinho", { emissao: { ligada: false, pausadaMotivo: "valor diferente" } }],
    ["a lista de códigos em espera que alguém mexeu", { emissao: { ligada: true, codigosEmEspera: [] } }],
    ["o tipo de operação trocado", { emissao: { ligada: true, tipoDeOperacao: { quitacao: "paymentReceivedBeforeSupply" } } }],
    ["o endereço do aviso do Conexa gerado de novo", { emissao: { ligada: true }, aviso: { tokenHash: "x" } }],
  ])("muda quando muda %s", (_, depois) => {
    const antes = { emissao: { ligada: true, codigosEmEspera: ["10.05.01"] } };
    expect(versaoDaConfig(depois)).not.toBe(versaoDaConfig(antes));
  });

  it("sem configuração gravada (linha nova, nula ou vazia) a versão é a mesma nos dois lados", () => {
    expect(versaoDaConfig(null)).toBe(versaoDaConfig(undefined));
    expect(versaoDaConfig(null)).toBe(versaoDaConfig({}));
  });

  it("a configuração lida e relida do banco mantém a versão do que está gravado", () => {
    // A tela e a ação leem a mesma linha: o que importa é o BRUTO, não o objeto já com os padrões.
    const gravada = { emissao: { ligada: true } };
    expect(versaoDaConfig(gravada)).toBe(versaoDaConfig({ emissao: { ligada: true } }));
    // ...e ler com os padrões não é a versão (seria igual para configs que o banco guarda diferentes).
    expect(versaoDaConfig(lerConfigNotasFiscais(gravada))).not.toBe(versaoDaConfig(gravada));
  });
});
