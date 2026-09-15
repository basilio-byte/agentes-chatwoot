import { describe, expect, it } from "vitest";
import {
  acrescentarNaLista,
  corpoDeAtualizacao,
  corpoDeClienteNovo,
  periodoDaAgenda,
  telefoneParaConexa,
} from "./entrada";

/**
 * O que vai PARA o Conexa.
 *
 * Os dois defeitos que criaram este módulo passaram por semanas de teste com
 * mock, porque mock aceita qualquer corpo — só a API de verdade recusou. Por
 * isso estes testes travam a forma que a DOCUMENTAÇÃO pede
 * (`docs/02-api-conexa.md`), campo a campo, e não o que o código já mandava.
 */

describe("periodoDaAgenda", () => {
  it("um dia vira o dia inteiro no horário de São Paulo", () => {
    // É o formato do exemplo de GET /room/bookings na documentação.
    expect(periodoDaAgenda("2026-09-15", "2026-09-15")).toEqual({
      de: "2026-09-15T00:00:00-03:00",
      ate: "2026-09-15T23:59:59-03:00",
    });
  });

  it("nunca manda o dia cru, que o Conexa recusa com 400", () => {
    // ⚠ Era o defeito: `bookingDateTimeFrom=2026-09-15` dava "The format of
    // bookingDateTimeFrom should be Y-m-d\TH:i:sP" em toda primeira consulta.
    const r = periodoDaAgenda("2026-09-15", "2026-09-16");
    if ("erro" in r) throw new Error(r.erro);
    expect(r.de).toBe("2026-09-15T00:00:00-03:00");
    expect(r.ate).toBe("2026-09-16T23:59:59-03:00");
  });

  it("só o início é só o início", () => {
    expect(periodoDaAgenda("2026-09-15")).toEqual({
      de: "2026-09-15T00:00:00-03:00",
      ate: undefined,
    });
  });

  it("data com hora e deslocamento passa como veio", () => {
    // É o que o modelo improvisava na segunda tentativa — e funcionava.
    expect(
      periodoDaAgenda("2026-09-15T08:00:00-03:00", "2026-09-15T12:00:00-03:00"),
    ).toEqual({
      de: "2026-09-15T08:00:00-03:00",
      ate: "2026-09-15T12:00:00-03:00",
    });
  });

  it("formato brasileiro é recusado antes de chamar a API", () => {
    const r = periodoDaAgenda("15/09/2026");
    expect(r).toHaveProperty("erro");
    expect((r as { erro: string }).erro).toContain("AAAA-MM-DD");
  });

  it("data que não existe é recusada", () => {
    expect(periodoDaAgenda("2026-02-30")).toHaveProperty("erro");
  });

  it("início depois do fim é recusado, porque voltaria agenda vazia", () => {
    // Numa consulta de disponibilidade, lista vazia se lê como "tudo livre".
    expect(periodoDaAgenda("2026-09-16", "2026-09-15")).toHaveProperty("erro");
  });

  it("sem datas, sem filtro", () => {
    expect(periodoDaAgenda()).toEqual({ de: undefined, ate: undefined });
  });
});

describe("corpoDeClienteNovo", () => {
  const base = { companyId: 3, nome: "Arthur Pereira da Rocha Lopes" };

  it("pessoa física: CPF dentro de naturalPerson, contato em listas", () => {
    const r = corpoDeClienteNovo({
      ...base,
      cpf: "01731631499",
      email: "arthur@exemplo.com",
      telefone: "8491631300",
    });

    expect(r).toEqual({
      corpo: {
        companyId: 3,
        name: "Arthur Pereira da Rocha Lopes",
        naturalPerson: { cpf: "017.316.314-99" },
        emailsMessage: ["arthur@exemplo.com"],
        phones: ["8491631300"],
      },
      avisos: [],
    });
  });

  it("NUNCA manda cpf, email ou phone no topo", () => {
    // ⚠ São exatamente os três campos do 400 de produção (11/09/2026):
    // "cpf" field does not exist or is not available in the company.
    const r = corpoDeClienteNovo({
      ...base,
      cpf: "017.316.314-99",
      email: "a@b.com",
      telefone: "84 99163-1300",
    });
    if ("erro" in r) throw new Error(r.erro);

    for (const proibido of ["cpf", "cnpj", "email", "phone", "legalName"]) {
      expect(r.corpo).not.toHaveProperty(proibido);
    }
  });

  it("empresa: CNPJ em legalPerson, razão social em name, fantasia em tradeName", () => {
    const r = corpoDeClienteNovo({
      companyId: 3,
      nome: "Fake ABC",
      razaoSocial: "Empresa Fake ABC Ltda",
      cnpj: "99557155000190",
    });

    expect(r).toEqual({
      corpo: {
        companyId: 3,
        name: "Empresa Fake ABC Ltda",
        tradeName: "Fake ABC",
        legalPerson: { cnpj: "99.557.155/0001-90" },
      },
      avisos: [],
    });
  });

  it("empresa sem razão social usa o nome informado", () => {
    const r = corpoDeClienteNovo({ companyId: 3, nome: "Fake ABC", cnpj: "99557155000190" });
    if ("erro" in r) throw new Error(r.erro);

    expect(r.corpo.name).toBe("Fake ABC");
    expect(r.corpo).not.toHaveProperty("tradeName");
  });

  it("sem documento, recusa", () => {
    expect(corpoDeClienteNovo(base)).toEqual({
      erro: "O Conexa exige CPF ou CNPJ para cadastrar.",
    });
  });

  it("CPF e CNPJ juntos, recusa em vez de escolher", () => {
    expect(
      corpoDeClienteNovo({ ...base, cpf: "01731631499", cnpj: "99557155000190" }),
    ).toHaveProperty("erro");
  });

  it("documento com dígito faltando é recusado", () => {
    expect(corpoDeClienteNovo({ ...base, cpf: "0173163149" })).toHaveProperty("erro");
    expect(corpoDeClienteNovo({ ...base, cnpj: "9955715500019" })).toHaveProperty("erro");
  });

  it("telefone do Chatwoot perde o 55 do país", () => {
    const r = corpoDeClienteNovo({ ...base, cpf: "01731631499", telefone: "+558491631300" });
    if ("erro" in r) throw new Error(r.erro);

    expect(r.corpo.phones).toEqual(["8491631300"]);
  });

  it("telefone sem DDD não é gravado, e o retorno diz isso", () => {
    // Cadastrar o cliente vale mais que o telefone; perder o telefone em
    // silêncio, não.
    const r = corpoDeClienteNovo({ ...base, cpf: "01731631499", telefone: "91631300" });
    if ("erro" in r) throw new Error(r.erro);

    expect(r.corpo).not.toHaveProperty("phones");
    expect(r.avisos).toHaveLength(1);
    expect(r.avisos[0]).toContain("91631300");
  });
});

describe("telefoneParaConexa", () => {
  it("aceita 10 ou 11 dígitos, com ou sem máscara", () => {
    expect(telefoneParaConexa("(84) 9163-1300")).toBe("8491631300");
    expect(telefoneParaConexa("84 99163-1300")).toBe("84991631300");
  });

  it("tira o 55 do país", () => {
    expect(telefoneParaConexa("+55 84 99163-1300")).toBe("84991631300");
    expect(telefoneParaConexa("+558491631300")).toBe("8491631300");
  });

  it("sem DDD, ou comprido demais, não serve", () => {
    expect(telefoneParaConexa("91631300")).toBeNull();
    expect(telefoneParaConexa("1234567890123")).toBeNull();
  });
});

describe("corpoDeAtualizacao", () => {
  it("e-mail novo é ACRESCENTADO aos que a equipe cadastrou", () => {
    // ⚠ O PATCH substitui a lista inteira: mandar só o novo apagaria os outros.
    const atual = { emailsMessage: ["financeiro@empresa.com", "dono@empresa.com"] };

    const r = corpoDeAtualizacao(atual, { email: "novo@empresa.com" });

    expect(r.corpo.emailsMessage).toEqual([
      "financeiro@empresa.com",
      "dono@empresa.com",
      "novo@empresa.com",
    ]);
  });

  it("e-mail que já existe não se repete, nem com outra caixa", () => {
    const r = corpoDeAtualizacao(
      { emailsMessage: ["Dono@Empresa.com"] },
      { email: "dono@empresa.com" },
    );
    expect(r.corpo.emailsMessage).toEqual(["Dono@Empresa.com"]);
  });

  it("telefone com máscara e com 55 conta como o mesmo número", () => {
    const r = corpoDeAtualizacao(
      { phones: ["(84) 99163-1300"] },
      { telefone: "+55 84 99163-1300" },
    );
    expect(r.corpo.phones).toEqual(["(84) 99163-1300"]);
  });

  it("nunca manda email ou phone no topo", () => {
    const r = corpoDeAtualizacao(
      {},
      { nome: "Maria", email: "m@x.com", telefone: "8491631300" },
    );
    expect(r.corpo).toEqual({
      name: "Maria",
      emailsMessage: ["m@x.com"],
      phones: ["8491631300"],
    });
  });

  it("telefone inválido não entra e vira aviso", () => {
    const r = corpoDeAtualizacao({ phones: ["8491631300"] }, { telefone: "123" });
    expect(r.corpo).not.toHaveProperty("phones");
    expect(r.avisos).toHaveLength(1);
  });

  it("lista ausente ou suja vira lista nova, sem quebrar", () => {
    expect(acrescentarNaLista(null, "a@b.com", (v) => v)).toEqual(["a@b.com"]);
    expect(acrescentarNaLista(["", "  "], "a@b.com", (v) => v)).toEqual(["a@b.com"]);
  });
});
