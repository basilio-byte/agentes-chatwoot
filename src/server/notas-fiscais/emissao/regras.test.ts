import { describe, expect, it } from "vitest";
import { notasFiscaisConfigSchema } from "../config";
import {
  codigoNacional,
  cortar,
  dataDeCompetencia,
  LIMITES,
  lerTomador,
  montarAviso,
  montarCorpo,
  motivoDaRecusa,
  podeEmitir,
  problemasDoTomador,
  situacaoDoStatus,
  type CepLido,
  type Tomador,
} from "./regras";

const config = (emissao: Record<string, unknown> = {}) =>
  notasFiscaisConfigSchema.parse({ emissao: { ligada: true, soCobrancas: [900], ...emissao } });

const linha = (extra: Record<string, unknown> = {}) => ({
  cobrancaId: 900,
  empresaId: 3,
  situacao: "PRONTA",
  referencia: "2026-10-07",
  ...extra,
});

const tomador = (extra: Partial<Tomador> = {}): Tomador => ({
  nome: "Maria da Silva",
  documento: "04578999483",
  email: "maria@exemplo.com",
  telefone: "84999990000",
  cep: "59056000",
  rua: "Rua das Flores",
  numero: "100",
  bairro: "Lagoa Nova",
  complemento: "Sala 2",
  cidade: "Natal",
  uf: "RN",
  ...extra,
});

const cepOk: CepLido = { estado: "ok", ibge: 2408102, cidade: "Natal", uf: "RN" };

const nota = {
  chave: "conexa-900-030302",
  codigo: "03.03.02",
  valorCentavos: 14900,
  descricao: "Reserva de sala",
  competencia: "2026-10",
};

describe("cortar", () => {
  it("aparo, junto os espaços repetidos e tiro quebra de linha", () => {
    expect(cortar("  Rua   das\nFlores \t 10 ", 100)).toBe("Rua das Flores 10");
  });

  it("⚠ corta no limite, e nunca deixa meio caractere", () => {
    expect(cortar("a".repeat(120), 80)).toHaveLength(80);
    const emoji = "😀".repeat(10); // 2 unidades cada
    const cortado = cortar(emoji, 5);
    expect(cortado).toBe("😀😀");
    expect(cortado).not.toContain("�");
  });

  it("texto vazio ou nulo vira vazio", () => {
    expect(cortar(null, 10)).toBe("");
    expect(cortar(undefined, 10)).toBe("");
  });
});

describe("a emissão só sai com todas as travas", () => {
  it("desligada: nada", () => {
    expect(podeEmitir(config({ ligada: false }), linha())).toEqual({ ok: false, motivo: "a emissão está desligada" });
  });

  it("só a cobrança que não está PRONTA fica de fora", () => {
    expect(podeEmitir(config(), linha({ situacao: "CONFERIR" })).ok).toBe(false);
    expect(podeEmitir(config(), linha({ situacao: "AGUARDANDO_CLASSIFICACAO" })).ok).toBe(false);
  });

  it("⚠ com lista liberada, só as da lista", () => {
    expect(podeEmitir(config(), linha()).ok).toBe(true);
    const fora = podeEmitir(config(), linha({ cobrancaId: 901 }));
    expect(fora).toEqual({ ok: false, motivo: "a cobrança não está na lista liberada" });
  });

  it("⚠ sem lista e sem dia de corte, NADA é emitido", () => {
    const r = podeEmitir(config({ soCobrancas: [] }), linha());
    expect(r).toEqual({ ok: false, motivo: "sem lista liberada nem dia de corte" });
  });

  it("⚠ sem lista, só o pago a partir do corte com o n8n: o anterior já teve a nota dele", () => {
    const c = config({ soCobrancas: [], aPartirDe: "2026-10-10" });
    expect(podeEmitir(c, linha({ referencia: "2026-10-09" })).ok).toBe(false);
    expect(podeEmitir(c, linha({ referencia: "2026-10-10" })).ok).toBe(true);
    expect(podeEmitir(c, linha({ referencia: null })).ok).toBe(false);
  });

  it("unidade do Conexa sem empresa na Spedy não emite", () => {
    expect(podeEmitir(config(), linha({ empresaId: 99 })).ok).toBe(false);
  });

  it("a lista liberada vale mesmo com corte: é a escolha explícita de uma pessoa", () => {
    const c = config({ soCobrancas: [900], aPartirDe: "2026-12-01" });
    expect(podeEmitir(c, linha({ referencia: "2026-10-01" })).ok).toBe(true);
  });
});

describe("tomador", () => {
  it("lê o cliente do Conexa, PF ou PJ, com o estado como objeto ou texto", () => {
    const t = lerTomador({
      name: " Empresa Ltda ",
      legalPerson: { cnpj: "11.222.333/0001-81" },
      emailsMessage: ["fin@empresa.com"],
      cellNumber: "(84) 99999-0000",
      address: {
        zipCode: "59056-000",
        street: "Rua A",
        number: "10",
        neighborhood: "Centro",
        city: "Natal",
        state: { abbreviation: "rn" },
      },
    });
    expect(t).toMatchObject({
      nome: "Empresa Ltda",
      documento: "11222333000181",
      email: "fin@empresa.com",
      telefone: "84999990000",
      cep: "59056000",
      uf: "RN",
    });
    expect(lerTomador({ naturalPerson: { cpf: "045.789.994-83" }, address: { state: "RN" } })).toMatchObject({
      documento: "04578999483",
      uf: "RN",
    });
  });

  it("cadastro completo e CEP certo: nenhum problema", () => {
    expect(problemasDoTomador(tomador(), cepOk)).toEqual([]);
  });

  it("⚠ CEP que não existe é problema de cadastro — antes de gastar número (E0240)", () => {
    expect(problemasDoTomador(tomador(), { estado: "inexistente" })).toEqual(["o CEP 59056000 do cadastro não existe"]);
  });

  it("⚠ CEP de outra cidade que a do cadastro também", () => {
    const p = problemasDoTomador(tomador({ cidade: "Parnamirim" }), cepOk);
    expect(p[0]).toMatch(/é de Natal, mas o cadastro diz Parnamirim/);
  });

  it("nome da cidade com acento e caixa diferentes não é divergência", () => {
    expect(problemasDoTomador(tomador({ cidade: "NATAL" }), { ...cepOk, cidade: "Natal" })).toEqual([]);
    expect(problemasDoTomador(tomador({ cidade: "São Gonçalo" }), { ...cepOk, cidade: "Sao Goncalo" })).toEqual([]);
  });

  it("⚠ consulta de CEP que falhou NÃO acusa o cliente: segue, e a prefeitura decide", () => {
    expect(problemasDoTomador(tomador(), { estado: "desconhecido" })).toEqual([]);
  });

  it("sem nome, documento ou CEP, diz o que falta", () => {
    expect(problemasDoTomador(tomador({ nome: "" }), cepOk)).toContain("o cadastro do cliente está sem nome");
    expect(problemasDoTomador(tomador({ documento: "123" }), cepOk)[0]).toMatch(/não tem 11 nem 14 dígitos/);
    expect(problemasDoTomador(tomador({ documento: "" }), cepOk)[0]).toMatch(/sem CPF ou CNPJ/);
    expect(problemasDoTomador(tomador({ cep: "590" }), { estado: "desconhecido" })[0]).toMatch(/não tem 8 dígitos/);
  });

  it("⚠ cadastro SEM CEP não segura a nota: o n8n mandou assim e a Spedy completou (07/10/2026)", () => {
    expect(problemasDoTomador(tomador({ cep: "" }), { estado: "desconhecido" })).toEqual([]);
    const c = montarCorpo({
      nota,
      tomador: tomador({ cep: "", rua: "", numero: "", bairro: "" }),
      cep: { estado: "desconhecido" },
      hoje: "2026-10-07",
      enviarEmailAoCliente: true,
    });
    expect(c.receiver.address).toBeUndefined();
    expect(c.receiver.federalTaxNumber).toBe("04578999483");
  });

  it("o telefone do cadastro não vai à Spedy, como no n8n", () => {
    expect(montarCorpo({ nota, tomador: tomador(), cep: cepOk, hoje: "2026-10-07", enviarEmailAoCliente: true }).receiver)
      .not.toHaveProperty("phoneNumber");
  });
});

describe("corpo da nota", () => {
  const corpo = (t: Tomador = tomador(), cep: CepLido = cepOk, n = nota) =>
    montarCorpo({ nota: n, tomador: t, cep, hoje: "2026-10-07", enviarEmailAoCliente: true });

  it("leva o código nacional só em dígitos, o valor em reais e o identificador da nota", () => {
    const c = corpo();
    expect(c.nationalTaxationCode).toBe("030302");
    expect(codigoNacional("10.05.01")).toBe("100501");
    expect(c.total.invoiceAmount).toBe(149);
    expect(c.integrationId).toBe("conexa-900-030302");
    expect(c.issue).toBe(true);
    expect(c.receiver.address!.city).toEqual({ code: 2408102, name: "Natal", state: "rn" });
    expect(c.receiver.address!.country).toBe("BRA");
  });

  it("⚠ o nome do cliente é cortado em 80 caracteres, como o n8n sempre fez", () => {
    const c = corpo(tomador({ nome: "N".repeat(130) }));
    expect(c.receiver.name).toHaveLength(80);
    expect(LIMITES.nome).toBe(80);
  });

  it("⚠ nenhum texto do endereço passa do limite que a Spedy declara", () => {
    const c = corpo(
      tomador({
        rua: "R".repeat(300),
        bairro: "B".repeat(300),
        numero: "9".repeat(40),
        complemento: "C".repeat(400),
      }),
    );
    const a = c.receiver.address!;
    expect(a.street).toHaveLength(100);
    expect(a.district).toHaveLength(100);
    expect(a.number).toHaveLength(10);
    expect(a.additionalInformation).toHaveLength(150);
    expect(a.postalCode.length).toBeLessThanOrEqual(15);
  });

  it("⚠ o identificador nunca passa de 36 caracteres", () => {
    const c = corpo(tomador(), cepOk, { ...nota, chave: "x".repeat(60) });
    expect(c.integrationId).toHaveLength(36);
  });

  it("número do endereço vazio vai como S/N; rua vazia fica de fora", () => {
    const c = corpo(tomador({ numero: "", rua: "" }));
    expect(c.receiver.address!.number).toBe("S/N");
    expect(c.receiver.address!.street).toBeUndefined();
  });

  it("⚠ e-mail grande demais NÃO é cortado (um e-mail pela metade é outro endereço): fica de fora", () => {
    const c = corpo(tomador({ email: `${"a".repeat(70)}@exemplo.com` }));
    expect(c.receiver.email).toBeUndefined();
    expect(c.sendEmailToCustomer).toBe(false);
  });

  it("manda o e-mail da nota ao cliente quando a config pede e há e-mail", () => {
    expect(corpo().sendEmailToCustomer).toBe(true);
    expect(
      montarCorpo({ nota, tomador: tomador(), cep: cepOk, hoje: "2026-10-07", enviarEmailAoCliente: false })
        .sendEmailToCustomer,
    ).toBe(false);
  });

  it("sem a consulta do CEP, usa a cidade do cadastro e deixa a Spedy achar o código", () => {
    const c = corpo(tomador(), { estado: "desconhecido" });
    expect(c.receiver.address!.city).toEqual({ name: "Natal", state: "rn" });
  });

  it("descrição longa é cortada", () => {
    expect(corpo(tomador(), cepOk, { ...nota, descricao: "d".repeat(3000) }).description).toHaveLength(LIMITES.descricao);
  });
});

describe("competência", () => {
  it("é o primeiro dia do mês da cobrança", () => {
    expect(dataDeCompetencia("2026-09", "2026-10-07")).toBe("2026-09-01");
    expect(dataDeCompetencia("2026-10", "2026-10-07")).toBe("2026-10-01");
  });

  it("⚠ mês que ainda não chegou fica de fora: a prefeitura recusaria data futura", () => {
    expect(dataDeCompetencia("2026-11", "2026-10-07")).toBeUndefined();
  });

  it("sem competência, ou com lixo, não manda data", () => {
    expect(dataDeCompetencia(null, "2026-10-07")).toBeUndefined();
    expect(dataDeCompetencia("lixo", "2026-10-07")).toBeUndefined();
  });
});

describe("texto do aviso à equipe", () => {
  const rejeitada = {
    chave: "conexa-900-030302",
    cobrancaId: 900,
    empresa: "SEATECH",
    codigo: "03.03.02",
    valorCentavos: 14900,
    situacao: "REJEITADA" as const,
    motivo: "E0240: O CEP do tomador não existe.",
  };

  it("uma nota: assunto no singular, cobrança, valor, código, motivo e o que fazer", () => {
    const a = montarAviso([rejeitada]);
    expect(a.assunto).toBe("NFS-e: 1 nota precisa de atenção");
    expect(a.texto).toMatch(/Cobrança #900 \(SEATECH\) — R\$\s?149,00, código 03\.03\.02/);
    expect(a.texto).toContain("Situação: rejeitada pela prefeitura");
    expect(a.texto).toContain("Motivo: E0240: O CEP do tomador não existe.");
    expect(a.texto).toMatch(/reemita pela tela da Spedy/);
  });

  it("várias notas vão num e-mail só, e cada causa pede uma providência diferente", () => {
    const a = montarAviso([
      rejeitada,
      { ...rejeitada, cobrancaId: 901, situacao: "FALHOU", motivo: "Cadastro do cliente: o CEP 59056000 do cadastro não existe" },
      { ...rejeitada, cobrancaId: 902, situacao: "FALHOU", motivo: "Spedy respondeu 400: dado inválido" },
    ]);
    expect(a.assunto).toBe("NFS-e: 3 notas precisam de atenção");
    expect(a.texto).toMatch(/Corrija o cadastro do cliente no Conexa/);
    expect(a.texto).toMatch(/Precisa de ajuda técnica/);
  });

  it("⚠ não leva nome nem documento do cliente", () => {
    const a = montarAviso([rejeitada]);
    expect(a.texto + a.html).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
  });

  it("⚠ o motivo vem da prefeitura: o HTML escapa o que ela escrever", () => {
    const a = montarAviso([{ ...rejeitada, motivo: '<img src=x onerror="alert(1)"> & mais' }]);
    expect(a.html).not.toContain("<img");
    expect(a.html).toContain("&lt;img");
    expect(a.html).toContain("&amp; mais");
  });
});

describe("o que a Spedy respondeu", () => {
  it("traduz o status", () => {
    expect(situacaoDoStatus("authorized")).toBe("AUTORIZADA");
    expect(situacaoDoStatus("rejected")).toBe("REJEITADA");
    expect(situacaoDoStatus("denied")).toBe("REJEITADA");
    expect(situacaoDoStatus("canceled")).toBe("CANCELADA");
    // Ainda não terminou: espera.
    for (const s of ["created", "enqueued", "received", "inContingent", "algoNovo"]) {
      expect(situacaoDoStatus(s)).toBe("ENVIADA");
    }
  });

  it("a recusa da prefeitura vem com o código e sem ruído", () => {
    expect(motivoDaRecusa({ code: "E0240", message: "  O CEP   informado  não existe. " })).toBe(
      "E0240: O CEP informado não existe.",
    );
    expect(motivoDaRecusa(null)).toMatch(/sem dizer o motivo/);
  });
});
