import { describe, expect, it } from "vitest";
import {
  assinaturaDoTexto,
  carimbar,
  escolherDestinatarios,
  jaAvisados,
  lerConfigAvisos,
  semNumeros,
} from "./regras";

/** Nomes e números inventados. */
const CADASTRO = [
  { nome: "Maria do Socorro", telefone: "+5584999990001" },
  { nome: "Wellington", telefone: "+5584999990002" },
  { nome: "Ana Paula", telefone: "+5584999990003" },
  { nome: "Ana Lúcia", telefone: "+5584999990004" },
];

describe("quem recebe", () => {
  it("nome igual vence, sem acento nem caixa", () => {
    const r = escolherDestinatarios(["WELLINGTON", "ana lucia"], CADASTRO);

    expect(r.escolhidos.map((d) => d.nome)).toEqual(["Wellington", "Ana Lúcia"]);
    expect(r.naoAchados).toEqual([]);
  });

  it("parte do nome casa nos dois sentidos", () => {
    expect(escolherDestinatarios(["Socorro"], CADASTRO).escolhidos[0].nome).toBe(
      "Maria do Socorro",
    );
    expect(
      escolherDestinatarios(["Wellington Silva"], CADASTRO).escolhidos[0].nome,
    ).toBe("Wellington");
  });

  it("⚠ nome que casa com duas pessoas é recusado, nunca palpite", () => {
    const r = escolherDestinatarios(["Ana"], CADASTRO);

    expect(r.escolhidos).toEqual([]);
    expect(r.ambiguos).toEqual(["Ana"]);
  });

  it("nome fora do cadastro vem apontado", () => {
    const r = escolherDestinatarios(["Fulano"], CADASTRO);

    expect(r.naoAchados).toEqual(["Fulano"]);
  });

  it("a mesma pessoa pedida duas vezes recebe uma vez", () => {
    const r = escolherDestinatarios(["Socorro", "Maria do Socorro"], CADASTRO);

    expect(r.escolhidos).toHaveLength(1);
  });

  it("palavra curta não casa sozinha: \"do\" não é ninguém", () => {
    expect(escolherDestinatarios(["do"], CADASTRO).naoAchados).toEqual(["do"]);
  });
});

describe("o recado", () => {
  it("leva o carimbo do sistema com o nome do agente", () => {
    expect(carimbar("Jardim: NEGATIVO", "Jardim — Padrão Ouro")).toBe(
      "🤖 Aviso automático · Jardim — Padrão Ouro\nJardim: NEGATIVO",
    );
  });

  it("não carimba duas vezes", () => {
    const uma = carimbar("Texto", "Agente");
    expect(carimbar(uma, "Agente")).toBe(uma);
  });

  it("a assinatura ignora espaço e caixa — é o mesmo recado", () => {
    expect(assinaturaDoTexto("Jardim:  NEGATIVO\n")).toBe(assinaturaDoTexto("jardim: negativo"));
    expect(assinaturaDoTexto("Jardim: POSITIVO")).not.toBe(assinaturaDoTexto("Jardim: NEGATIVO"));
  });

  it("número de telefone some do texto que volta ao modelo", () => {
    expect(semNumeros("phone +55 84 99999-0001 has already been taken")).toBe(
      "phone [número] has already been taken",
    );
    expect(semNumeros("Chatwoot respondeu 422")).toBe("Chatwoot respondeu 422");
  });
});

describe("recado repetido", () => {
  const A = assinaturaDoTexto("recado A");

  it("só conta entrega aceita do MESMO recado", () => {
    const nomes = jaAvisados(
      [
        { output: { assinatura: A, entregas: [{ nome: "Wellington", ok: true }] } },
        { output: { assinatura: A, entregas: [{ nome: "Maria do Socorro", ok: false }] } },
        { output: { assinatura: "outra", entregas: [{ nome: "Ana Paula", ok: true }] } },
        { output: { simulado: true, para: ["Ana Lúcia"] } },
        { output: "texto solto" },
      ],
      A,
    );

    expect([...nomes]).toEqual(["wellington"]);
  });
});

describe("configuração", () => {
  it("sem nada gravado: ninguém e a caixa 31", () => {
    expect(lerConfigAvisos(null)).toEqual({ destinatarios: [], caixaId: 31 });
  });

  it("linha gravada sem telefone válido é descartada", () => {
    const c = lerConfigAvisos({
      destinatarios: [
        { nome: "Wellington", telefone: "(84) 99999-0002" },
        { nome: "Quebrado", telefone: "abc" },
      ],
    });

    expect(c.destinatarios).toEqual([{ nome: "Wellington", telefone: "+5584999990002" }]);
  });
});
