import { describe, expect, it } from "vitest";
import { configDoFormulario, lerConfigFollowup, TEXTO_PADRAO } from "./config";

const formulario = (sobre: Record<string, string> = {}) => {
  const campos: Record<string, string> = {
    modo: "sombra",
    horasAntesDoInicio: "3",
    minutosAposReserva: "30",
    horaDeInicio: "8",
    horaDeFim: "20",
    texto: TEXTO_PADRAO,
    ...sobre,
  };
  return (campo: string) => campos[campo] ?? null;
};

const erroDe = (lido: ReturnType<typeof configDoFormulario>) => ("erro" in lido ? lido.erro : null);

describe("config do follow-up de reserva", () => {
  it("sem nada gravado: sombra, 3 h antes, 30 min depois de reservar, 8h às 20h", () => {
    expect(lerConfigFollowup({})).toMatchObject({
      modo: "sombra",
      horasAntesDoInicio: 3,
      minutosAposReserva: 30,
      horaDeInicio: 8,
      horaDeFim: 20,
      texto: TEXTO_PADRAO,
    });
  });

  it("config inválida gravada à mão cai nos padrões, e nunca vira ligado", () => {
    expect(lerConfigFollowup({ modo: "ligado", horaDeInicio: 22, horaDeFim: 6 }).modo).toBe("sombra");
  });

  it("o formulário certo passa, com vírgula decimal", () => {
    const lido = configDoFormulario(formulario({ modo: "ligado", horasAntesDoInicio: "2,5" }));
    expect("config" in lido && lido.config).toMatchObject({ modo: "ligado", horasAntesDoInicio: 2.5 });
  });

  it("marcador desconhecido é recusado: sairia literal ao cliente", () => {
    expect(erroDe(configDoFormulario(formulario({ texto: `${TEXTO_PADRAO} {cliente}` })))).toMatch(
      /\{cliente\} não é marcador conhecido/,
    );
  });

  it("sem {link} é recusado: o follow-up existe para mandar a cobrança", () => {
    expect(erroDe(configDoFormulario(formulario({ texto: "Oi, {nome}! Tudo certo com a sua reserva?" })))).toMatch(
      /\{link\}/,
    );
  });

  it("número em branco é recusa, não zero", () => {
    expect(erroDe(configDoFormulario(formulario({ minutosAposReserva: "" })))).toMatch(/Minutos depois/);
  });

  it("fim do horário antes do começo é recusa", () => {
    expect(erroDe(configDoFormulario(formulario({ horaDeInicio: "20", horaDeFim: "8" })))).toMatch(
      /Hora em que o envio para/,
    );
  });
});
