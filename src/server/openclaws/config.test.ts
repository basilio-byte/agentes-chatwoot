import { describe, expect, it } from "vitest";
import { RESET_PADRAO } from "./ciclo";
import {
  idsDaContaCompartilhada,
  lerConteineres,
  mesclarConteineres,
  nomeDoConteiner,
  resetValido,
} from "./config";

describe("lerConteineres", () => {
  it("lê a lista gravada e preenche o que faltar", () => {
    expect(lerConteineres([{ id: "lr9a", nome: "Diego" }, { id: "2bpu", nome: "Guilherme", compartilhada: false }])).toEqual([
      { id: "lr9a", nome: "Diego", compartilhada: true },
      { id: "2bpu", nome: "Guilherme", compartilhada: false },
    ]);
  });

  it("lista inválida ou ausente vira vazia: a tela continua abrindo", () => {
    expect(lerConteineres(undefined)).toEqual([]);
    expect(lerConteineres("lr9a")).toEqual([]);
    expect(lerConteineres([{ id: "LR 9A" }])).toEqual([]);
  });

  it("id repetido vale pela primeira ocorrência", () => {
    expect(lerConteineres([{ id: "lr9a", nome: "Diego" }, { id: "lr9a", nome: "Outro" }])).toHaveLength(1);
    expect(lerConteineres([{ id: "lr9a", nome: "Diego" }, { id: "lr9a", nome: "Outro" }])[0].nome).toBe("Diego");
  });
});

describe("nomeDoConteiner", () => {
  it("usa o nome cadastrado, e o id quando não há", () => {
    const lista = lerConteineres([{ id: "lr9a", nome: "Diego" }, { id: "fkv5", nome: "  " }]);
    expect(nomeDoConteiner("lr9a", lista)).toBe("Diego");
    expect(nomeDoConteiner("fkv5", lista)).toBe("OpenClaw fkv5");
    expect(nomeDoConteiner("zzzz", lista)).toBe("OpenClaw zzzz");
  });
});

describe("idsDaContaCompartilhada", () => {
  it("tira só quem foi marcado como conta própria", () => {
    const lista = lerConteineres([{ id: "2bpu", nome: "Guilherme", compartilhada: false }]);
    expect([...idsDaContaCompartilhada(lista, ["2bpu", "lr9a", "fkv5"])].sort()).toEqual(["fkv5", "lr9a"]);
  });

  it("contêiner desconhecido conta como compartilhado", () => {
    expect([...idsDaContaCompartilhada([], ["novo1"])]).toEqual(["novo1"]);
  });
});

describe("mesclarConteineres", () => {
  it("acrescenta o que falta sem mexer no que existe", () => {
    const atuais = lerConteineres([{ id: "lr9a", nome: "Diego", compartilhada: true }]);
    const novo = mesclarConteineres(atuais, ["lr9a", "xqxb"]);
    expect(novo).toEqual([
      { id: "lr9a", nome: "Diego", compartilhada: true },
      { id: "xqxb", nome: null, compartilhada: true },
    ]);
  });
});

describe("resetValido", () => {
  it("aceita dia de 0 a 6 e hora de 0 a 23", () => {
    expect(resetValido("3", "8")).toEqual({ diaSemana: 3, horaUtc: 8 });
    expect(resetValido(0, 19)).toEqual({ diaSemana: 0, horaUtc: 19 });
  });

  it("qualquer coisa fora disso volta ao padrão", () => {
    expect(resetValido(7, 19)).toEqual(RESET_PADRAO);
    expect(resetValido(0, 24)).toEqual(RESET_PADRAO);
    expect(resetValido("domingo", 19)).toEqual(RESET_PADRAO);
    expect(resetValido(1.5, 19)).toEqual(RESET_PADRAO);
  });
});
