import { describe, expect, it } from "vitest";
import { PREFERENCIA_DE_PROVEDOR } from "./openrouter";

/**
 * A escolha de provedor é decisão do usuário (15/09/2026), não detalhe de
 * implementação: mudar exige mudar este teste de propósito.
 */
describe("preferência de provedor na OpenRouter", () => {
  it("⚠ prioriza vazão, não preço", () => {
    // Sem preferência, a OpenRouter pesa pelo preço, e o provedor barato levou
    // 219 s e 478 s numa ida só ao modelo — acima dos 3 minutos do vigia.
    expect(PREFERENCIA_DE_PROVEDOR.sort).toBe("throughput");
  });

  it("não restringe provedores: o fallback continua valendo", () => {
    // Excluir quantização ou fixar provedor tira a rede de quem cai quando um
    // provedor falha. Ficou para depois de medir.
    expect(Object.keys(PREFERENCIA_DE_PROVEDOR)).toEqual(["sort"]);
  });
});
