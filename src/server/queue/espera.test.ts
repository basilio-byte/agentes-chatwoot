import { describe, expect, it } from "vitest";
import {
  esperouDemais,
  minutosDeEspera,
  MINUTOS_MINIMO,
  MINUTOS_PADRAO,
} from "./espera";

const AGORA = 1_800_000_000_000;
const atras = (min: number) => new Date(AGORA - min * 60_000);

describe("minutosDeEspera", () => {
  it("sem configuração, usa o padrão", () => {
    expect(minutosDeEspera(null)).toBe(MINUTOS_PADRAO);
    expect(minutosDeEspera(undefined)).toBe(MINUTOS_PADRAO);
  });

  it("respeita o que o agente definiu", () => {
    expect(minutosDeEspera(10)).toBe(10);
  });

  it("não deixa descer abaixo do piso", () => {
    // Zero ou negativo arrancaria a conversa do agente antes de ele terminar
    // de pensar — um turno com transferências leva dezenas de segundos.
    expect(minutosDeEspera(0)).toBe(MINUTOS_MINIMO);
    expect(minutosDeEspera(-5)).toBe(MINUTOS_MINIMO);
  });
});

describe("esperouDemais", () => {
  it("estourou o tempo com o bot atendendo", () => {
    expect(
      esperouDemais({ status: "BOT", aguardandoDesde: atras(4) }, 3, AGORA),
    ).toBe(true);
  });

  it("ainda dentro do prazo", () => {
    expect(
      esperouDemais({ status: "BOT", aguardandoDesde: atras(2) }, 3, AGORA),
    ).toBe(false);
  });

  it("sem ninguém esperando, não escala", () => {
    // Nulo = o agente já respondeu, ou nunca houve pergunta pendente.
    expect(
      esperouDemais({ status: "BOT", aguardandoDesde: null }, 3, AGORA),
    ).toBe(false);
  });

  it("conversa que já é de humano não é escalada de novo", () => {
    expect(
      esperouDemais({ status: "HUMAN", aguardandoDesde: atras(30) }, 3, AGORA),
    ).toBe(false);
  });

  it("conversa encerrada fica fora", () => {
    expect(
      esperouDemais({ status: "CLOSED", aguardandoDesde: atras(30) }, 3, AGORA),
    ).toBe(false);
  });

  it("no limite exato já conta", () => {
    expect(
      esperouDemais({ status: "BOT", aguardandoDesde: atras(3) }, 3, AGORA),
    ).toBe(true);
  });
});
