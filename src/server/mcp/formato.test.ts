import { describe, expect, it } from "vitest";
import {
  arredondarUsd,
  quando,
  recortarTexto,
  recusar,
  semSegredos,
} from "./formato";

describe("formato das respostas do MCP", () => {
  it("data sai no horário de São Paulo, não em UTC", () => {
    expect(quando(new Date("2026-09-11T15:00:00Z"))).toMatch(/11\/09\/2026.*12:00/);
    expect(quando(null)).toBeNull();
  });

  it("recorta sem partir emoji e diz quanto sobrou", () => {
    expect(recortarTexto("😀".repeat(5), 3)).toBe("😀😀😀… [+2 caracteres]");
    expect(recortarTexto("curto", 10)).toBe("curto");
    expect(recortarTexto(null, 10)).toBeNull();
  });

  it("chave com cara de segredo não sai, nem aninhada", () => {
    expect(
      semSegredos({
        baseUrl: "https://x",
        apiToken: "pk_123",
        listas: [{ nome: "Leads", webhookSecret: "s" }],
        private_key: "-----BEGIN",
      }),
    ).toEqual({
      baseUrl: "https://x",
      apiToken: "[omitido]",
      listas: [{ nome: "Leads", webhookSecret: "[omitido]" }],
      private_key: "[omitido]",
    });
  });

  it("telefone de pessoa não sai, mas o id de um campo de telefone sai", () => {
    expect(
      semSegredos({
        avisar: [{ nome: "Diego", telefone: "+5584999999999" }],
        campoTelefone: "3399c6f6",
      }),
    ).toEqual({
      avisar: [{ nome: "Diego", telefone: "[omitido]" }],
      campoTelefone: "3399c6f6",
    });
  });

  it("recusa é erro de execução, com contexto quando há", () => {
    expect(recusar("não deu")).toEqual({ erro: true, texto: "não deu" });
    expect(JSON.parse(recusar("não deu", { validas: ["a"] }).texto)).toEqual({
      erro: "não deu",
      validas: ["a"],
    });
  });

  it("custo em dólar com seis casas, sem ruído de ponto flutuante", () => {
    expect(arredondarUsd(0.1 + 0.2)).toBe(0.3);
    expect(arredondarUsd(0.00070049)).toBe(0.0007);
  });
});
