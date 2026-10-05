import { describe, expect, it } from "vitest";
import {
  clientesEmTexto,
  configDoFormulario,
  lerClientes,
  lerConfigNotasFiscais,
  normalizarCodigo,
  regraDoCliente,
} from "./config";

const padrao = lerConfigNotasFiscais({});

describe("código de serviço", () => {
  it("aceita com ou sem pontos e devolve no formato da task", () => {
    expect(normalizarCodigo("03.03.02")).toBe("03.03.02");
    expect(normalizarCodigo("030302")).toBe("03.03.02");
    expect(normalizarCodigo(" 10 05 01 ")).toBe("10.05.01");
  });

  it("recusa o que não tem seis dígitos", () => {
    expect(normalizarCodigo("03.03")).toBeNull();
    expect(normalizarCodigo("1.05.01")).toBeNull();
    expect(normalizarCodigo("abc")).toBeNull();
  });
});

describe("regras por cliente", () => {
  it("lê uma por linha, com observação opcional", () => {
    expect(lerClientes("3245 antes paga antes do boleto\n\n4742 NUNCA\n")).toEqual({
      clientes: [
        { clienteId: 3245, regra: "antes", observacao: "paga antes do boleto" },
        { clienteId: 4742, regra: "nunca", observacao: "" },
      ],
    });
  });

  it("⚠ uma linha inválida recusa tudo, dizendo qual — gravar só as boas apagaria a errada em silêncio", () => {
    const lido = lerClientes("3245 antes\nNORTH nunca");
    expect(lido).toEqual({ erro: expect.stringContaining("linha 2") });
  });

  it("recusa o mesmo cliente duas vezes", () => {
    expect(lerClientes("1 antes\n1 nunca")).toEqual({ erro: expect.stringContaining("mais de uma vez") });
  });

  it("volta para a tela no mesmo formato", () => {
    const config = lerConfigNotasFiscais({
      clientes: [{ clienteId: 1, regra: "nunca", observacao: "retém ISS" }],
    });
    expect(clientesEmTexto(config)).toBe("1 nunca retém ISS");
    expect(regraDoCliente(config, 1)).toBe("nunca");
    expect(regraDoCliente(config, 2)).toBeNull();
  });
});

describe("formulário", () => {
  it("monta a tabela de códigos a partir dos campos codigo_<categoria>, normalizando", () => {
    const lido = configDoFormulario(
      { codigo_10: "030302", codigo_3: "10.05.01", codigo_8: "", codigoReservaDeSala: "03.03.02", inicio: "2026-10-06", clientes: "" },
      padrao,
    );
    expect(lido).toEqual({
      config: expect.objectContaining({
        codigos: { "10": "03.03.02", "3": "10.05.01" },
        codigoReservaDeSala: "03.03.02",
        inicio: "2026-10-06",
      }),
    });
  });

  it("recusa código mal formado dizendo a categoria", () => {
    expect(configDoFormulario({ codigo_23: "11.04" }, padrao)).toEqual({
      erro: expect.stringContaining("Categoria 23"),
    });
    expect(configDoFormulario({ codigoReservaDeSala: "3.3" }, padrao)).toEqual({
      erro: expect.stringContaining("Reserva de sala"),
    });
  });

  it("início vazio fica nulo (a rodada usa hoje)", () => {
    const lido = configDoFormulario({ inicio: "" }, padrao);
    expect("config" in lido && lido.config.inicio).toBeNull();
  });

  it("config mexida à mão cai nos padrões em vez de quebrar", () => {
    expect(lerConfigNotasFiscais({ codigos: { "10": "errado" } })).toEqual(padrao);
  });
});
