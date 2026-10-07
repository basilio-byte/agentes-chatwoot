import { beforeEach, describe, expect, it, vi } from "vitest";
import { consultarCep, esquecerCeps } from "./cep";

const json = (corpo: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(corpo), { status }));

beforeEach(() => esquecerCeps());

describe("consulta de CEP", () => {
  it("devolve cidade, UF e o código IBGE", async () => {
    const buscar = vi.fn(() => json({ cep: "59056-000", localidade: "Natal", uf: "RN", ibge: "2408102" }));
    expect(await consultarCep("59056000", { buscar })).toEqual({ estado: "ok", ibge: 2408102, cidade: "Natal", uf: "RN" });
  });

  it("⚠ só `erro: true` do ViaCEP diz que o CEP não existe", async () => {
    expect(await consultarCep("99999999", { buscar: () => json({ erro: true }) })).toEqual({ estado: "inexistente" });
  });

  it("⚠ serviço fora do ar, resposta estranha ou CEP malformado são 'desconhecido', nunca 'inexistente'", async () => {
    expect(await consultarCep("59056000", { buscar: () => Promise.reject(new Error("rede")) })).toEqual({ estado: "desconhecido" });
    expect(await consultarCep("59056000", { buscar: () => json({}, 500) })).toEqual({ estado: "desconhecido" });
    expect(await consultarCep("59056000", { buscar: () => json({ foo: 1 }) })).toEqual({ estado: "desconhecido" });
    expect(await consultarCep("abc", { buscar: vi.fn() })).toEqual({ estado: "desconhecido" });
  });

  it("guarda por 24 h: o mesmo CEP não é consultado de novo", async () => {
    const buscar = vi.fn(() => json({ localidade: "Natal", uf: "RN", ibge: "2408102" }));
    await consultarCep("59056000", { buscar, agora: 0 });
    await consultarCep("59056000", { buscar, agora: 60_000 });
    expect(buscar).toHaveBeenCalledTimes(1);
    await consultarCep("59056000", { buscar, agora: 25 * 3600_000 });
    expect(buscar).toHaveBeenCalledTimes(2);
  });

  it("falha não fica guardada: a próxima rodada tenta de novo", async () => {
    const buscar = vi.fn().mockRejectedValueOnce(new Error("rede")).mockImplementation(() => json({ localidade: "Natal", uf: "RN", ibge: "2408102" }));
    expect((await consultarCep("59056000", { buscar })).estado).toBe("desconhecido");
    expect((await consultarCep("59056000", { buscar })).estado).toBe("ok");
  });
});
