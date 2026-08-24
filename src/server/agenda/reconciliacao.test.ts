import { describe, expect, it } from "vitest";
import { reconciliar } from "./reconciliacao";

describe("reconciliação entre Postgres e Redis", () => {
  it("cria o que falta", () => {
    const r = reconciliar(["a", "b"], []);
    expect(r.paraSincronizar.sort()).toEqual(["a", "b"]);
    expect(r.paraRemover).toEqual([]);
  });

  it("remove o que sobrou no Redis", () => {
    // Agendamento apagado ou desligado enquanto o worker estava fora do ar.
    const r = reconciliar(["a"], ["a", "orfao"]);
    expect(r.paraRemover).toEqual(["orfao"]);
  });

  it("ressincroniza o que já existe — a expressão pode ter mudado", () => {
    // Não basta criar o que falta: alguém pode ter trocado o horário enquanto o
    // worker estava fora, e o Redis ficaria com o horário antigo para sempre.
    const r = reconciliar(["a"], ["a"]);
    expect(r.paraSincronizar).toEqual(["a"]);
    expect(r.paraRemover).toEqual([]);
  });

  it("Redis limpo é reconstruído por inteiro", () => {
    const r = reconciliar(["a", "b", "c"], []);
    expect(r.paraSincronizar).toHaveLength(3);
  });

  it("nada de um lado e nada do outro não faz nada", () => {
    expect(reconciliar([], [])).toEqual({ paraSincronizar: [], paraRemover: [] });
  });

  it("tudo desligado no banco esvazia o Redis", () => {
    const r = reconciliar([], ["a", "b"]);
    expect(r.paraSincronizar).toEqual([]);
    expect(r.paraRemover.sort()).toEqual(["a", "b"]);
  });
});
