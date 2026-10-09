import { describe, expect, it } from "vitest";
import {
  EXIGE_NFSE_REFERENCIADA,
  ROTULO_DO_TIPO_DE_OPERACAO,
  TIPO_DE_OPERACAO_PADRAO,
  TIPOS_DE_OPERACAO,
} from "@/lib/tipos-de-operacao";
import { lerConfigNotasFiscais, notasFiscaisConfigSchema } from "../config";
import {
  codigoNacional,
  codigoQueSegura,
  divergenciaDeValor,
  exigeTipoDeOperacao,
  motivoParaPausar,
  vagasNaCautela,
  cortar,
  dataDeCompetencia,
  LIMITES,
  lerTomador,
  DIAS_DA_JANELA_DE_EMISSAO,
  montarAviso,
  oQueImpedeASaida,
  montarCorpo,
  motivoDaRecusa,
  podeEmitir,
  problemasDoTomador,
  situacaoDoStatus,
  type CepLido,
  type Problema,
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

  it("⚠ cidade do cadastro diferente da do CEP NÃO segura a nota: vale a cidade do CEP (08/10/2026)", () => {
    // Cadastro real: endereço do prédio em Natal com "Acari" no campo cidade.
    const t = tomador({ cidade: "Acari" });
    expect(problemasDoTomador(t, cepOk)).toEqual([]);
    const c = montarCorpo({ nota, tomador: t, cep: cepOk, hoje: "2026-10-07", enviarEmailAoCliente: true });
    expect(c.receiver.address!.city).toEqual({ code: 2408102, name: "Natal", state: "rn" });
    expect(c.receiver.address!.postalCode).toBe("59056000");
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

describe("tipo de operação (E0903 da prefeitura, 09/10/2026)", () => {
  const sala = { ...nota, chave: "conexa-900-100501", codigo: "10.05.01" };
  const corpo = (n: typeof nota, momento?: "quitacao" | "geracao") =>
    montarCorpo({ nota: n, tomador: tomador(), cep: cepOk, hoje: "2026-10-09", enviarEmailAoCliente: true, momento });

  it("⚠ sala privativa (10.05.01) leva o tipo de operação que o Laércio definiu para cada momento", () => {
    // A ÚLTIMA resposta dele (09/10/2026, "bota a opção 1 e 4 para ver se roda"):
    // quitação = fornecimento com pagamento posterior; geração = recebimento do
    // pagamento com fornecimento posterior. As duas anteriores caíam na regra E0905.
    expect(corpo(sala).ibsCbs).toEqual({ operationType: "supplyWithSubsequentPayment" });
    expect(corpo(sala, "quitacao").ibsCbs).toEqual({ operationType: "supplyWithSubsequentPayment" });
    expect(corpo(sala, "geracao").ibsCbs).toEqual({ operationType: "paymentReceivedBeforeSupply" });
  });

  it("⚠ o que está na CONFIGURAÇÃO manda: trocar o tipo não pede deploy", () => {
    const tipos = { quitacao: "simultaneousSupplyAndPayment", geracao: "supplyWithSubsequentPayment" } as const;
    const c = (momento: "quitacao" | "geracao") =>
      montarCorpo({ nota: sala, tomador: tomador(), cep: cepOk, hoje: "2026-10-09", enviarEmailAoCliente: true, momento, tiposDeOperacao: tipos });
    expect(c("quitacao").ibsCbs).toEqual({ operationType: "simultaneousSupplyAndPayment" });
    expect(c("geracao").ibsCbs).toEqual({ operationType: "supplyWithSubsequentPayment" });
  });

  it("⚠ a nota comum (03.03.02) e o Seabox (11.04.01) saem EXATAMENTE como antes, sem o campo", () => {
    expect(corpo(nota)).not.toHaveProperty("ibsCbs");
    expect(corpo({ ...nota, codigo: "11.04.01" }, "geracao")).not.toHaveProperty("ibsCbs");
    expect(JSON.stringify(corpo(nota))).not.toContain("operationType");
  });

  it("os quatro itens que a prefeitura listou exigem; o vizinho não", () => {
    for (const codigo of ["10.05.01", "10.05.02", "15.09.01", "17.12.01", "25.05.01"]) {
      expect(exigeTipoDeOperacao(codigo), codigo).toBe(true);
    }
    for (const codigo of ["10.04.01", "10.06.01", "03.03.02", "11.04.01", "01.05.01", "15.10.01", "25.05"]) {
      expect(exigeTipoDeOperacao(codigo), codigo).toBe(false);
    }
  });

  it("o padrão por momento é a última resposta do Laércio (e o 2 e o 3 são os que exigem NFS-e referenciada)", () => {
    expect(TIPO_DE_OPERACAO_PADRAO).toEqual({ quitacao: "supplyWithSubsequentPayment", geracao: "paymentReceivedBeforeSupply" });
    // ⚠ O padrão NUNCA pode ser um dos que exigem a nota referenciada: a Seahub não consegue enviá-la.
    for (const tipo of Object.values(TIPO_DE_OPERACAO_PADRAO)) expect(EXIGE_NFSE_REFERENCIADA[tipo], tipo).toBe(false);
    expect(Object.entries(EXIGE_NFSE_REFERENCIADA).filter(([, exige]) => exige).map(([tipo]) => tipo)).toEqual([
      "paymentReceivedAfterSupply",
      "supplyWithPriorPayment",
    ]);
    // Os cinco têm rótulo na tela, na ordem de 1 a 5.
    expect(TIPOS_DE_OPERACAO.map((t) => ROTULO_DO_TIPO_DE_OPERACAO[t][0])).toEqual(["1", "2", "3", "4", "5"]);
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
    expect(a.texto).toMatch(/use "Tentar de novo" na lista de notas/);
    expect(a.texto).toMatch(/sem gastar outro número/);
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

describe("a cautela (regras puras)", () => {
  it("na cautela é uma nota por vez; passada a cautela não há limite", () => {
    expect(vagasNaCautela({ cautela: 3, autorizadas: 0, emVoo: 0 })).toBe(1);
    expect(vagasNaCautela({ cautela: 3, autorizadas: 2, emVoo: 1 })).toBe(0);
    expect(vagasNaCautela({ cautela: 3, autorizadas: 3, emVoo: 5 })).toBe(Number.POSITIVE_INFINITY);
    expect(vagasNaCautela({ cautela: 0, autorizadas: 0, emVoo: 5 })).toBe(Number.POSITIVE_INFINITY);
  });

  it("valor registrado diferente do planejado é divergência; igual, ou não informado, não é", () => {
    expect(divergenciaDeValor({ cobrancaId: 7, valorCentavos: 14900, valorNaSpedy: 149 })).toBeNull();
    expect(divergenciaDeValor({ cobrancaId: 7, valorCentavos: 112273, valorNaSpedy: 1122.73 })).toBeNull();
    expect(divergenciaDeValor({ cobrancaId: 7, valorCentavos: 14900, valorNaSpedy: undefined })).toBeNull();
    expect(divergenciaDeValor({ cobrancaId: 7, valorCentavos: 14900, valorNaSpedy: 148.99 })).toMatch(
      /cobrança 7.*R\$ 148,99.*R\$ 149,00/,
    );
  });

  const p = (tipo: Problema["tipo"], texto: string): Problema => ({ tipo, texto });

  it("na cautela QUALQUER problema desliga", () => {
    expect(motivoParaPausar({ emCautela: true, problemas: [] })).toBeNull();
    expect(motivoParaPausar({ emCautela: true, problemas: [p("rejeitada", "a")] })).toMatch(/nas primeiras notas: a/);
    expect(motivoParaPausar({ emCautela: true, problemas: [p("recusa", "b")] })).toMatch(/nas primeiras notas: b/);
  });

  it("⚠ passada a cautela, nota NÃO emitida (rejeitada pela prefeitura) nunca desliga, por mais que sejam", () => {
    const muitas = Array.from({ length: 12 }, (_, i) => p("rejeitada", `cobrança ${i}`));
    expect(motivoParaPausar({ emCautela: false, problemas: muitas })).toBeNull();
  });

  it("⚠ passada a cautela, valor diferente do planejado desliga NA PRIMEIRA: é nota fiscal errada", () => {
    expect(motivoParaPausar({ emCautela: false, problemas: [p("divergencia", "cobrança 7: a Spedy registrou R$ 1,00")] })).toBe(
      "valor diferente do planejado: cobrança 7: a Spedy registrou R$ 1,00",
    );
    // Misturada com rejeições, a causa dita é a divergência.
    expect(
      motivoParaPausar({ emCautela: false, problemas: [p("rejeitada", "x"), p("divergencia", "y")] }),
    ).toBe("valor diferente do planejado: y");
  });

  it("recusa da Spedy: uma ou duas são casos; três na mesma rodada são defeito geral e desligam", () => {
    expect(motivoParaPausar({ emCautela: false, problemas: [p("recusa", "a"), p("recusa", "b")] })).toBeNull();
    expect(
      motivoParaPausar({ emCautela: false, problemas: ["a", "b", "c", "d"].map((t) => p("recusa", t)) }),
    ).toMatch(/^4 recusas da Spedy numa rodada: a \| b \| c \(\+1\)/);
    // Recusas e rejeições não se somam: a conta é só das recusas.
    expect(
      motivoParaPausar({ emCautela: false, problemas: [p("recusa", "a"), p("recusa", "b"), p("rejeitada", "c")] }),
    ).toBeNull();
  });
});

describe("cobrança paga sem nota no e-mail", () => {
  const retida = {
    chave: "retida:30594:10.05.01",
    cobrancaId: 30594,
    empresa: "SEAHUB",
    valorCentavos: 112668,
    tipo: "retida" as const,
    detalhe: "o código 10.05.01 está em espera, aguardando uma decisão fiscal",
  };

  it("só cobranças sem nota: assunto próprio, o que está guardado e o que fazer", () => {
    const a = montarAviso([], [retida]);
    expect(a.assunto).toBe("NFS-e: 1 cobrança paga sem nota");
    expect(a.texto).toContain("Uma cobrança paga ainda não gerou nota (fica guardada, nada se perde):");
    expect(a.texto).toMatch(/Cobrança #30594 \(SEAHUB\) — R\$\s?1\.126,68/);
    expect(a.texto).toContain("Situação: retida (código em espera)");
    expect(a.texto).toContain("Motivo: o código 10.05.01 está em espera");
    expect(a.texto).toMatch(/tire o código da lista "Códigos em espera"/);
    expect(a.texto).not.toContain("Uma nota fiscal precisa de atenção");
  });

  it("notas com problema E cobranças sem nota vão no mesmo e-mail, cada uma na sua lista", () => {
    const rejeitada = {
      chave: "conexa-900-030302",
      cobrancaId: 900,
      empresa: "SEATECH",
      codigo: "03.03.02",
      valorCentavos: 14900,
      situacao: "REJEITADA" as const,
      motivo: "E0240: O CEP do tomador não existe.",
    };
    const a = montarAviso([rejeitada], [retida, { ...retida, chave: "decisao:7:CONFERIR", cobrancaId: 7, tipo: "conferir", detalhe: "as vendas não somam" }]);
    expect(a.assunto).toBe("NFS-e: 3 itens precisam de atenção");
    expect(a.texto).toContain("Uma nota fiscal precisa de atenção:");
    expect(a.texto).toContain("2 cobranças pagas ainda não geraram nota (ficam guardadas, nada se perde):");
    expect(a.texto).toContain("Situação: para conferir");
    expect(a.html).toContain("<ul>");
  });

  it("⚠ o detalhe pode vir de fora (motivo da sombra): o HTML escapa", () => {
    const a = montarAviso([], [{ ...retida, detalhe: '<script>alert("x")</script>' }]);
    expect(a.html).not.toContain("<script>");
    expect(a.html).toContain("&lt;script&gt;");
  });

  it("sem cobrança sem nota, o e-mail é exatamente o de antes", () => {
    const rejeitada = {
      chave: "k",
      cobrancaId: 1,
      empresa: "SEAHUB",
      codigo: "03.03.02",
      valorCentavos: 100,
      situacao: "REJEITADA" as const,
      motivo: "x",
    };
    expect(montarAviso([rejeitada], [])).toEqual(montarAviso([rejeitada]));
    expect(montarAviso([rejeitada]).assunto).toBe("NFS-e: 1 nota precisa de atenção");
  });

  it("⚠ a cobrança retida diz até quando ela sai sozinha (a rodada só olha 60 dias para trás)", () => {
    expect(montarAviso([], [retida]).texto).toContain(`menos de ${DIAS_DA_JANELA_DE_EMISSAO} dias`);
    expect(DIAS_DA_JANELA_DE_EMISSAO).toBe(60);
  });

  describe("plano que mudou depois da emissão", () => {
    const mudou = {
      chave: "plano:31000:conexa-31000-030302",
      cobrancaId: 31000,
      empresa: "SEAHUB",
      valorCentavos: 14900,
      tipo: "plano mudou" as const,
      detalhe: "o plano da cobrança mudou depois da emissão: já existe conexa-31000-030302 (03.03.02, autorizada, nº 2700)",
    };

    it("entra na lista das cobranças pagas sem nota, com o que fazer: conferir na Spedy, nada em dobro", () => {
      const a = montarAviso([], [mudou]);
      expect(a.assunto).toBe("NFS-e: 1 cobrança paga sem nota");
      expect(a.texto).toContain("Situação: plano mudou depois da emissão");
      expect(a.texto).toContain("conexa-31000-030302 (03.03.02, autorizada, nº 2700)");
      expect(a.texto).toMatch(/nada mais é emitido dela/);
      expect(a.texto).toMatch(/Confira na Spedy/);
    });
  });

  describe("emissão desligada sozinha", () => {
    const pausa = {
      chave: "pausa:2026-10-09T15:00",
      cobrancaId: 0,
      empresa: "",
      valorCentavos: 0,
      tipo: "pausada" as const,
      detalhe: "valor diferente do planejado: cobrança 31000: a Spedy registrou R$ 99,99 e o planejado era R$ 149,00",
    };
    const rejeitada = {
      chave: "conexa-900-030302",
      cobrancaId: 900,
      empresa: "SEATECH",
      codigo: "03.03.02",
      valorCentavos: 14900,
      situacao: "REJEITADA" as const,
      motivo: "E0240: O CEP do tomador não existe.",
    };

    it("⚠ assunto próprio e o motivo à frente — sem fingir que é uma cobrança sem nota", () => {
      const a = montarAviso([], [pausa]);
      expect(a.assunto).toBe("NFS-e: a emissão foi desligada sozinha");
      expect(a.texto).toContain("⚠ A emissão parou:");
      expect(a.texto).toContain("A emissão automática de notas fiscais foi DESLIGADA");
      expect(a.texto).toContain("Motivo: valor diferente do planejado");
      expect(a.texto).toMatch(/ligue a emissão de novo em Integrações → Notas fiscais/);
      // Não é uma cobrança: nada de "#0", nem de "cobranças pagas ainda não geraram nota".
      expect(a.texto).not.toContain("Cobrança #0");
      expect(a.texto).not.toContain("ainda não gerou nota");
    });

    it("a pausa vai antes das notas com problema, e cada coisa na sua lista", () => {
      const a = montarAviso([rejeitada], [pausa]);
      expect(a.assunto).toBe("NFS-e: a emissão foi desligada sozinha");
      expect(a.texto.indexOf("⚠ A emissão parou:")).toBeLessThan(a.texto.indexOf("Uma nota fiscal precisa de atenção:"));
      expect(a.texto).toContain("Cobrança #900 (SEATECH)");
      expect(a.html).toContain("<strong>⚠ A emissão parou:</strong>");
    });

    it("com cobranças sem nota junto, só elas entram na contagem da lista delas", () => {
      const retida = {
        chave: "retida:1:10.05.01",
        cobrancaId: 1,
        empresa: "SEAHUB",
        valorCentavos: 100,
        tipo: "retida" as const,
        detalhe: "o código 10.05.01 está em espera",
      };
      const a = montarAviso([], [pausa, retida]);
      expect(a.texto).toContain("Uma cobrança paga ainda não gerou nota");
      expect(a.texto).not.toContain("2 cobranças pagas");
    });

    it("o motivo vem do sistema, mas o HTML escapa do mesmo jeito", () => {
      const a = montarAviso([], [{ ...pausa, detalhe: '<b onclick="x">' }]);
      expect(a.html).not.toContain("<b onclick");
      expect(a.html).toContain("&lt;b onclick=&quot;x&quot;&gt;");
    });
  });
});

describe("o que impede uma nota liberada de sair", () => {
  const base = () => ({
    integracaoLigada: true,
    config: lerConfigNotasFiscais({ emissao: { ligada: true, aPartirDe: "2026-10-08" } }),
    nota: { codigo: "10.05.01", empresa: "SEAHUB" },
    chaveDaEmpresaNoServidor: true,
  });
  const cobranca = { cobrancaId: 30594, empresaId: 3, situacao: "PRONTA", referencia: "2026-10-09" };

  it("nada impede: devolve vazio e a nota sai na próxima rodada", () => {
    expect(oQueImpedeASaida({ ...base(), cobranca })).toEqual([]);
    expect(oQueImpedeASaida(base())).toEqual([]);
  });

  it("⚠ emissão desligada: o botão não pode prometer 'sai em até 5 minutos'", () => {
    const config = lerConfigNotasFiscais({ emissao: { ligada: false, aPartirDe: "2026-10-08" } });
    expect(oQueImpedeASaida({ ...base(), config })).toEqual([expect.stringContaining("a emissão está desligada")]);
  });

  it("integração desligada vale mais que a emissão desligada (uma frase só)", () => {
    const config = lerConfigNotasFiscais({ emissao: { ligada: false } });
    expect(oQueImpedeASaida({ ...base(), config, integracaoLigada: false })).toEqual([
      "a integração de notas fiscais está desligada",
    ]);
  });

  it("código em espera e falta de chave são ditos, os dois juntos se for o caso", () => {
    const config = lerConfigNotasFiscais({ emissao: { ligada: true, aPartirDe: "2026-10-08", codigosEmEspera: ["10.05.01"] } });
    expect(oQueImpedeASaida({ ...base(), config, chaveDaEmpresaNoServidor: false })).toEqual([
      expect.stringContaining("o código 10.05.01 está em espera"),
      "falta a chave da Spedy da empresa SEAHUB no servidor",
    ]);
  });

  it("cobrança fora do corte, ou fora da lista liberada, também segura — e é dita só uma vez", () => {
    expect(oQueImpedeASaida({ ...base(), cobranca: { ...cobranca, referencia: "2026-10-07" } })).toEqual([
      "é anterior ao corte com o n8n",
    ]);
    const comLista = lerConfigNotasFiscais({ emissao: { ligada: true, soCobrancas: [1] } });
    expect(oQueImpedeASaida({ ...base(), config: comLista, cobranca })).toEqual(["a cobrança não está na lista liberada"]);
    // Emissão desligada E cobrança fora do corte: a primeira frase não se repete dentro da segunda.
    const desligada = lerConfigNotasFiscais({ emissao: { ligada: false, aPartirDe: "2026-10-08" } });
    const frases = oQueImpedeASaida({ ...base(), config: desligada, cobranca: { ...cobranca, referencia: "2026-10-07" } });
    expect(frases).toHaveLength(2);
    expect(frases.filter((f) => f.includes("desligada"))).toHaveLength(1);
  });
});

describe("códigos em espera (regra pura)", () => {
  const notas = [{ codigo: "03.03.02" }, { codigo: "10.05.01" }];

  it("sem lista, nada é retido", () => {
    expect(codigoQueSegura(notas, [])).toBeNull();
  });

  it("⚠ UMA nota com código em espera segura a cobrança inteira, e diz qual código", () => {
    expect(codigoQueSegura(notas, ["10.05.01"])).toBe("10.05.01");
  });

  it("cobrança sem nenhum dos códigos não é retida", () => {
    expect(codigoQueSegura([{ codigo: "03.03.02" }], ["10.05.01"])).toBeNull();
    expect(codigoQueSegura([], ["10.05.01"])).toBeNull();
  });
});
