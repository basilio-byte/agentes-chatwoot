import { describe, expect, it } from "vitest";
import { converterValor } from "./campos";
import {
  dentroDoBrasil,
  ehValorDeLocalizacao,
  extrairCep,
  formatarCep,
  limparEndereco,
  valorDeLocalizacao,
} from "./localizacao";

const ENDERECO_SOCIO = { id: "f1", name: "📍 Endereço Sócio", type: "location" };

describe("extrairCep", () => {
  it("acha o CEP com e sem hífen, no meio do endereço", () => {
    expect(extrairCep("Rua das Flores, 100, Natal - RN, 59064-500")).toBe("59064500");
    expect(extrairCep("Rua das Flores, 100, Natal - RN, CEP 59064500.")).toBe("59064500");
  });

  it("não confunde com número maior (telefone, CPF) nem com número de casa", () => {
    expect(extrairCep("Rua das Flores, 100, Natal")).toBeNull();
    expect(extrairCep("Rua A, 4985, Natal")).toBeNull();
    expect(extrairCep("ligar para 84981806770")).toBeNull();
  });

  it("formata", () => {
    expect(formatarCep("59064500")).toBe("59064-500");
  });
});

describe("dentroDoBrasil", () => {
  it("aceita Natal e recusa lixo (0,0, hemisfério errado, NaN)", () => {
    expect(dentroDoBrasil({ lat: -5.83, lng: -35.22 })).toBe(true);
    expect(dentroDoBrasil({ lat: 0, lng: 0 })).toBe(false);
    expect(dentroDoBrasil({ lat: 5.83, lng: 35.22 })).toBe(false);
    expect(dentroDoBrasil({ lat: Number.NaN, lng: -35 })).toBe(false);
  });
});

describe("valorDeLocalizacao", () => {
  it("monta o corpo que a API do ClickUp aceitou: lat/lng + texto, SEM place_id", () => {
    const v = valorDeLocalizacao("  Rua   Jaguarari, 4985,  Natal - RN ", {
      lat: -5.8300919123456,
      lng: -35.2224058,
    });
    expect(v).toEqual({
      location: { lat: -5.8300919, lng: -35.2224058 },
      formatted_address: "Rua Jaguarari, 4985, Natal - RN",
    });
    expect(v).not.toHaveProperty("place_id");
  });

  it("limpa espaço e corta o texto em 300 caracteres", () => {
    expect(limparEndereco("a   b\n c ")).toBe("a b c");
    expect(limparEndereco("x".repeat(500))).toHaveLength(300);
  });
});

describe("ehValorDeLocalizacao", () => {
  const bom = { location: { lat: -5.83, lng: -35.22 }, formatted_address: "Rua X, 1" };

  it("aceita o formato da API", () => {
    expect(ehValorDeLocalizacao(bom)).toBe(true);
  });

  it("recusa texto, objeto incompleto, endereço vazio e coordenada fora do Brasil", () => {
    expect(ehValorDeLocalizacao("Rua X, 1")).toBe(false);
    expect(ehValorDeLocalizacao(null)).toBe(false);
    expect(ehValorDeLocalizacao({ location: { lat: -5.83 }, formatted_address: "Rua X" })).toBe(false);
    expect(ehValorDeLocalizacao({ ...bom, formatted_address: "  " })).toBe(false);
    expect(ehValorDeLocalizacao({ ...bom, location: { lat: 0, lng: 0 } })).toBe(false);
  });
});

describe("converterValor em campo de localização", () => {
  it("⚠ texto cru é RECUSADO aqui, em vez de seguir para a API, que recusaria o lote inteiro", () => {
    const r = converterValor(ENDERECO_SOCIO, "Rua X, 100, Natal - RN, 59064-500");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.motivo).toContain("coordenadas");
  });

  it("o valor já convertido passa como está", () => {
    const valor = { location: { lat: -5.83, lng: -35.22 }, formatted_address: "Rua X, 1" };
    expect(converterValor(ENDERECO_SOCIO, valor)).toEqual({ ok: true, valor });
  });
});
