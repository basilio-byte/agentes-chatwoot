import { describe, expect, it } from "vitest";

import { lerResumoAnterior, serializarResumo, somarAoDia } from "./resumo-do-dia";

describe("somarAoDia", () => {
  it("⚠ o caso de 24/11/2026: a rodada que não escreve nada NÃO apaga a que escreveu", () => {
    const manha = somarAoDia(null, { propagados: 10, desfechos: [{ contratoId: 1 }], pendentes: ["a"] }, {
      listas: ["desfechos"],
      contadores: ["propagados"],
    });
    const tarde = somarAoDia(manha, { propagados: 0, desfechos: [], pendentes: [] }, {
      listas: ["desfechos"],
      contadores: ["propagados"],
    });

    expect(tarde.propagados).toBe(10);
    expect(tarde.desfechos).toEqual([{ contratoId: 1 }]);
    expect(tarde.rodadas).toBe(2);
  });

  it("o que foi feito soma sem repetir; o estado (pendentes) é o de agora", () => {
    const r = somarAoDia(
      { movidas: ["x", "y"], pendentes: ["velha"], rodadas: 3 },
      { movidas: ["y", "z"], pendentes: ["nova"] },
      { listas: ["movidas"] },
    );
    expect(r.movidas).toEqual(["x", "y", "z"]);
    expect(r.pendentes).toEqual(["nova"]);
    expect(r.rodadas).toBe(4);
  });

  it("o erro só fica se a rodada de AGORA falhou", () => {
    const comErro = somarAoDia(null, { erro: "ClickUp fora do ar" });
    expect(comErro.erro).toBe("ClickUp fora do ar");
    const depois = somarAoDia(comErro, { movidas: [] }, { listas: ["movidas"] });
    expect(depois.erro).toBeUndefined();
  });

  it("o marcador de corte de um resumo anterior não vira item", () => {
    const r = somarAoDia({ movidas: ["a", "… e mais 3"] }, { movidas: ["b"] }, { listas: ["movidas"] });
    expect(r.movidas).toEqual(["a", "b"]);
  });
});

describe("serializarResumo", () => {
  it("cabendo no teto, sai inteiro", () => {
    expect(serializarResumo({ a: 1, b: ["x"] })).toBe('{"a":1,"b":["x"]}');
  });

  it("⚠ grande demais: as listas encolhem e o texto continua sendo JSON VÁLIDO", () => {
    // O corte antigo em 2.000 caracteres partia o JSON no meio, e o MCP devolvia
    // um texto que nenhum leitor de JSON abre.
    const pendentes = Array.from({ length: 200 }, (_, i) => `cliente ${i}: contrato ${i}: um motivo qualquer`);
    const texto = serializarResumo({ acao: "propagado", propagados: 49, pendentes }, 1000);

    expect(texto.length).toBeLessThanOrEqual(1000);
    const lido = JSON.parse(texto);
    expect(lido.propagados).toBe(49);
    expect(lido.pendentes.at(-1)).toMatch(/^… e mais \d+$/);
  });

  it("lista de objetos ganha o marcador como objeto", () => {
    const desfechos = Array.from({ length: 100 }, (_, i) => ({ contratoId: i, tarefaId: `t${i}` }));
    const lido = JSON.parse(serializarResumo({ desfechos }, 600));
    expect(lido.desfechos.at(-1)).toHaveProperty("… e mais");
  });
});

describe("lerResumoAnterior", () => {
  it("JSON partido pelo corte antigo conta como nada, sem lançar", () => {
    expect(lerResumoAnterior('{"acao":"propagado","pendentes":["4029: contr')).toBeNull();
    expect(lerResumoAnterior(null)).toBeNull();
    expect(lerResumoAnterior('{"rodadas":2}')).toEqual({ rodadas: 2 });
  });
});
