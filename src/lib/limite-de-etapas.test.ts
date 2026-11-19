import { describe, expect, it } from "vitest";
import {
  marcarLimiteDeEtapas,
  marcarRespostaCortada,
  ressalvaDaExecucao,
} from "./limite-de-etapas";

describe("ressalvaDaExecucao", () => {
  it("reconhece as duas ressalvas de uma execução SUCCESS", () => {
    expect(ressalvaDaExecucao(marcarLimiteDeEtapas(12))).toBe("parou no limite de etapas");
    expect(ressalvaDaExecucao(marcarRespostaCortada(16384, true))).toBe(
      "resposta cortada no teto de tokens",
    );
    expect(ressalvaDaExecucao(marcarRespostaCortada(16384, false))).toBe(
      "resposta cortada no teto de tokens",
    );
  });

  it("erro de verdade, ou nenhum registro, não é ressalva", () => {
    expect(ressalvaDaExecucao("Request timed out.")).toBeNull();
    expect(ressalvaDaExecucao(null)).toBeNull();
    expect(ressalvaDaExecucao(undefined)).toBeNull();
  });
});

describe("marcarRespostaCortada", () => {
  it("⚠ não usa as palavras que a view de métricas lê como falha de conexão", () => {
    // Mesma expressão de `metricas_v1.execucoes.categoria_do_erro`.
    const conexao = /(terminated|timeout|timed out|econn|socket|fetch failed|network|aborted)/i;
    expect(marcarRespostaCortada(16384, true)).not.toMatch(conexao);
    expect(marcarRespostaCortada(16384, false)).not.toMatch(conexao);
  });

  it("diz o teto que valeu", () => {
    expect(marcarRespostaCortada(8000, true)).toContain("8000");
  });
});
