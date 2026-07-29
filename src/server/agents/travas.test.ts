import { describe, expect, it } from "vitest";
import {
  LIMITE_DE_VISITAS,
  LIMITE_POR_PAR,
  MAX_SALTOS,
  PRAZO_DO_TURNO_MS,
  chaveDoPar,
  explicarParada,
  novoEstado,
  podeTransferir,
  registrarTransferencia,
  registrarVisita,
} from "./travas";

const T0 = 1_000_000;

/** Simula uma transferência autorizada, como o worker faz. */
function transferir(estado: ReturnType<typeof novoEstado>, de: string, para: string, agora = T0) {
  const v = podeTransferir(estado, de, para, agora);
  if (v.pode) registrarTransferencia(estado, de, para);
  return v;
}

describe("chaveDoPar", () => {
  it("A→B e B→A são a mesma dupla — é o que detecta o pinga-pong", () => {
    expect(chaveDoPar("a", "b")).toBe(chaveDoPar("b", "a"));
  });
});

describe("par repetido", () => {
  it("deixa a ida-e-volta legítima acontecer", () => {
    const e = novoEstado(T0);
    registrarVisita(e, "a");

    // a → b (pergunta ao colega) e b → a (devolve com a resposta): normal.
    expect(transferir(e, "a", "b").pode).toBe(true);
    expect(transferir(e, "b", "a").pode).toBe(true);
  });

  it("corta quando a dupla passa do limite de travessias", () => {
    const e = novoEstado(T0);
    registrarVisita(e, "a");

    for (let i = 0; i < LIMITE_POR_PAR; i++) {
      const ida = i % 2 === 0;
      expect(transferir(e, ida ? "a" : "b", ida ? "b" : "a").pode).toBe(true);
    }

    expect(podeTransferir(e, "a", "b", T0)).toEqual({
      pode: false,
      motivo: "par_repetido",
    });
  });

  it("o pinga-pong é diagnosticado como par, não como visitas", () => {
    // A ordem das travas define o texto da nota interna. Se a de visitas
    // disparasse antes, quem for resolver leria "agente acionado demais" e
    // perderia o fato de que são DOIS agentes se devolvendo a conversa.
    const e = novoEstado(T0);
    registrarVisita(e, "a");
    for (let i = 0; i < LIMITE_POR_PAR; i++) {
      const ida = i % 2 === 0;
      transferir(e, ida ? "a" : "b", ida ? "b" : "a");
    }

    const v = podeTransferir(e, "a", "b", T0);
    expect(v.pode === false && v.motivo).toBe("par_repetido");
  });
});

describe("cadeias legítimas de atendimento", () => {
  it("passa por vários especialistas distintos sem esbarrar em trava", () => {
    // reservas → documentos → serviços → suporte → especialista de recurso.
    const e = novoEstado(T0);
    registrarVisita(e, "entrada");

    const cadeia = ["reservas", "documentos", "servicos", "suporte", "recurso"];
    let atual = "entrada";
    for (const proximo of cadeia) {
      expect(transferir(e, atual, proximo).pode, proximo).toBe(true);
      atual = proximo;
    }
  });

  it("recepção que distribui volta a atender várias vezes", () => {
    // O padrão concentrador: entrada despacha, o especialista devolve, e a
    // entrada despacha de novo para outro assunto.
    const e = novoEstado(T0);
    registrarVisita(e, "entrada");

    for (const especialista of ["reservas", "documentos", "suporte"]) {
      expect(transferir(e, "entrada", especialista).pode, especialista).toBe(true);
      expect(transferir(e, especialista, "entrada").pode, especialista).toBe(true);
    }
  });
});

describe("visitas por agente", () => {
  it("o mesmo agente não é acionado infinitas vezes no turno", () => {
    const e = novoEstado(T0);
    registrarVisita(e, "entrada");

    // Parceiros sempre distintos, para isolar a trava de visitas do par.
    let de = "entrada";
    for (let i = 0; i < LIMITE_DE_VISITAS; i++) {
      transferir(e, de, "x"); // visita i+1 de x
      de = `parceiro${i}`;
      transferir(e, "x", de);
    }

    expect(podeTransferir(e, de, "x", T0)).toEqual({
      pode: false,
      motivo: "visitas_excedidas",
    });
  });

  it("escala com a equipe: cadeia de distintos passa sem esbarrar", () => {
    const e = novoEstado(T0);
    registrarVisita(e, "a");

    expect(transferir(e, "a", "b").pode).toBe(true);
    expect(transferir(e, "b", "c").pode).toBe(true);
    expect(transferir(e, "c", "d").pode).toBe(true);
    expect(transferir(e, "d", "f").pode).toBe(true);
  });
});

describe("prazo do turno", () => {
  it("é a trava que mede o que o cliente sente", () => {
    const e = novoEstado(T0);
    const v = podeTransferir(e, "a", "b", T0 + PRAZO_DO_TURNO_MS);

    expect(v).toEqual({ pode: false, motivo: "prazo_esgotado" });
  });

  it("dentro do prazo, segue", () => {
    const e = novoEstado(T0);
    expect(podeTransferir(e, "a", "b", T0 + PRAZO_DO_TURNO_MS - 1).pode).toBe(true);
  });

  it("vence antes do teto de saltos — segundos importam mais que contagem", () => {
    const e = novoEstado(T0);
    const v = podeTransferir(e, "a", "b", T0 + PRAZO_DO_TURNO_MS);
    expect(v.pode === false && v.motivo).toBe("prazo_esgotado");
  });
});

describe("teto de saltos", () => {
  it("é rede de segurança: com equipe grande e sem repetir, ainda corta", () => {
    const e = novoEstado(T0);
    for (let i = 0; i < MAX_SALTOS; i++) {
      // Pares sempre distintos e visitas dentro do limite: só o teto pode barrar.
      registrarTransferencia(e, `de${i}`, `para${i}`);
    }

    const v = podeTransferir(e, "novo", "outro", T0);
    expect(v).toEqual({ pode: false, motivo: "teto_de_saltos" });
  });
});

describe("explicarParada", () => {
  it("todo motivo tem texto para a nota interna", () => {
    for (const motivo of [
      "par_repetido",
      "visitas_excedidas",
      "prazo_esgotado",
      "teto_de_saltos",
    ] as const) {
      expect(explicarParada(motivo).length).toBeGreaterThan(20);
    }
  });
});

describe("calibragem", () => {
  it("o par tem de morder antes das visitas, senão o diagnóstico se perde", () => {
    expect(LIMITE_POR_PAR).toBeLessThanOrEqual(LIMITE_DE_VISITAS);
  });

  it("o teto de saltos é rede de segurança, não a trava principal", () => {
    expect(LIMITE_POR_PAR).toBeLessThan(MAX_SALTOS);
    expect(LIMITE_DE_VISITAS).toBeLessThan(MAX_SALTOS);
  });
});
