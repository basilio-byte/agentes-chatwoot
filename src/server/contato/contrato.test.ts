import { describe, expect, it } from "vitest";
import {
  avisoDeContratoIncompleto,
  camposDoContratoParaPreencher,
  cnpjDosCampos,
  ehVendaDeEnderecoDoAgente,
  faltamParaOContrato,
  fimDoContrato,
  mesesDoContrato,
} from "./contrato";

/** Os campos do CRM Comercial que importam aqui, com os nomes REAIS da lista. */
const LISTA = [
  { name: "NOME CLIENTE" },
  { name: "E-mail" },
  { name: "CPF" },
  { name: "CNPJ [CADASTRO]" },
  { name: "VENDEDOR" },
  { name: "TIPO DE PRODUTO" },
  { name: "RAMO DE ATIVIDADE" },
  { name: "Sede da Empresa" },
  { name: "RESPONSÁVEL" },
  { name: "E-mail do responsável" },
  { name: "✍️ Razão Social" },
  { name: "RG / ID / RNE" },
  { name: "📍 Endereço Sócio" },
  { name: "DATA INICIO CONTRATO" },
  { name: "DATA DE ENCERRAMENTO CONTRATO [BASE CLIENTES]" },
  { name: "VENCIMENTO" },
  { name: "CELULAR" },
  { name: "VALOR CONTRATO" },
  { name: "Estado Civil" },
  { name: "FATURAMENTO" },
  { name: "CPF ou CNPJ Preenchidos" },
];

/** O que o Everton mandou na venda da conversa 14818 (sem o ramo, que a 1ª tentativa recusou). */
const DO_AGENTE = [
  { campo: "VENDEDOR", valor: "Auto Venda" },
  { campo: "NOME CLIENTE", valor: "Maria Souza Exemplo" },
  { campo: "E-mail", valor: "maria@exemplo.com" },
  { campo: "CNPJ [CADASTRO]", valor: "11.222.333/0001-81" },
  { campo: "Sede da Empresa", valor: "Rua das Flores, 100, Natal/RN, CEP 59000-000" },
  { campo: "TIPO DE PRODUTO", valor: "Endereço Fiscal Litoral" },
  { campo: "CELULAR", valor: "+55 84 90000 0000" },
  { campo: "VALOR CONTRATO", valor: 96.9 },
  { campo: "Estado Civil", valor: "Casado" },
  { campo: "FATURAMENTO", valor: "Mensal (a cada mês)" },
  { campo: "CPF ou CNPJ Preenchidos", valor: true },
];

const DESCRICAO =
  "Plano Litoral Bianual, pagamento mensal de R$ 96,90, contrato de 24 meses. Alteração de endereço de empresa já existente. Venda fechada pelo Everton (IA) no WhatsApp.";

const preencher = (extra: Partial<Parameters<typeof camposDoContratoParaPreencher>[0]> = {}) =>
  camposDoContratoParaPreencher({
    campos: DO_AGENTE,
    camposDaLista: LISTA,
    descricao: DESCRICAO,
    hoje: "2026-10-26",
    razaoSocial: "EXEMPLO SERVICOS LTDA",
    ...extra,
  });

describe("ehVendaDeEnderecoDoAgente", () => {
  it("Auto Venda com produto de endereço é a venda do agente", () => {
    expect(ehVendaDeEnderecoDoAgente(DO_AGENTE)).toBe(true);
    expect(
      ehVendaDeEnderecoDoAgente([
        { campo: "vendedor", valor: "auto venda" },
        { campo: "tipo de produto", valor: "Endereço de Comércio" },
      ]),
    ).toBe(true);
  });

  it("⚠ reserva de sala também é Auto Venda, mas não tem contrato", () => {
    expect(
      ehVendaDeEnderecoDoAgente([
        { campo: "VENDEDOR", valor: "Auto Venda" },
        { campo: "TIPO DE PRODUTO", valor: "Sala de reunião" },
      ]),
    ).toBe(false);
  });

  it("⚠ task de vendedor humano ou de lead em negociação não é tocada", () => {
    expect(
      ehVendaDeEnderecoDoAgente([
        { campo: "VENDEDOR", valor: "Alan" },
        { campo: "TIPO DE PRODUTO", valor: "Endereço Fiscal Litoral" },
      ]),
    ).toBe(false);
    expect(ehVendaDeEnderecoDoAgente([])).toBe(false);
  });
});

describe("mesesDoContrato", () => {
  it("lê a duração que o prompt manda o agente escrever", () => {
    expect(mesesDoContrato(DESCRICAO)).toBe(24);
    expect(mesesDoContrato("Plano Litoral Anual, 12x de R$ 107,10, contrato de 12 meses.")).toBe(12);
    expect(mesesDoContrato("24 meses de contrato")).toBe(24);
  });

  it("⚠ '12x' do cartão não é duração, e número fora de 12 e 24 não vira data", () => {
    expect(mesesDoContrato("Parcelado em 12x de R$ 107,10.")).toBeUndefined();
    expect(mesesDoContrato("contrato de 18 meses")).toBeUndefined();
    expect(mesesDoContrato("pagamento em 12 meses")).toBeUndefined();
    expect(mesesDoContrato(undefined)).toBeUndefined();
  });
});

describe("fimDoContrato", () => {
  it("26/10/2026 por 24 meses termina em 25/10/2028 — o que a equipe gravou na 14818", () => {
    expect(fimDoContrato("2026-10-26", 24)).toBe("2028-10-25");
  });

  it("por 12 meses", () => {
    expect(fimDoContrato("2026-10-26", 12)).toBe("2027-10-25");
  });

  it("virada de ano e primeiro dia do mês", () => {
    expect(fimDoContrato("2026-12-15", 12)).toBe("2027-12-14");
    expect(fimDoContrato("2026-11-01", 12)).toBe("2027-10-31");
  });

  it("dia que não existe no mês de chegada cai no último dia dele", () => {
    // 29/02/2028 + 12 meses: fevereiro de 2029 só vai até 28 → termina em 27.
    expect(fimDoContrato("2028-02-29", 12)).toBe("2029-02-27");
    expect(fimDoContrato("2026-01-31", 12)).toBe("2027-01-30");
  });
});

describe("camposDoContratoParaPreencher", () => {
  it("na venda da 14818 preenche responsável, e-mail, datas, vencimento e razão social", () => {
    expect(preencher()).toEqual([
      { campo: "RESPONSÁVEL", valor: "Maria Souza Exemplo" },
      { campo: "E-mail do responsável", valor: "maria@exemplo.com" },
      { campo: "DATA INICIO CONTRATO", valor: "2026-10-26" },
      { campo: "VENCIMENTO", valor: 26 },
      { campo: "DATA DE ENCERRAMENTO CONTRATO [BASE CLIENTES]", valor: "2028-10-25" },
      { campo: "✍️ Razão Social", valor: "EXEMPLO SERVICOS LTDA" },
    ]);
  });

  it("⚠ só preenche o vazio: o que o agente mandou fica, mesmo com o nome do campo pela metade", () => {
    const r = preencher({
      campos: [
        ...DO_AGENTE,
        { campo: "RESPONSÁVEL", valor: "Maria S. Exemplo" },
        { campo: "Razão Social", valor: "Exemplo Ltda" },
        { campo: "VENCIMENTO", valor: 10 },
      ],
    });
    expect(r.map((c) => c.campo)).toEqual([
      "E-mail do responsável",
      "DATA INICIO CONTRATO",
      "DATA DE ENCERRAMENTO CONTRATO [BASE CLIENTES]",
    ]);
  });

  it("⚠ 'E-mail' do agente não conta como 'E-mail do responsável' já preenchido", () => {
    expect(preencher().some((c) => c.campo === "E-mail do responsável")).toBe(true);
  });

  it("sem a duração na descrição, a data de fim fica em branco", () => {
    const r = preencher({ descricao: "Plano Litoral, alteração de endereço." });
    expect(r.some((c) => c.campo.startsWith("DATA DE ENCERRAMENTO"))).toBe(false);
    expect(r.some((c) => c.campo === "DATA INICIO CONTRATO")).toBe(true);
  });

  it("⚠ consulta de CNPJ sem resposta: a razão social fica em branco, nunca inventada", () => {
    expect(preencher({ razaoSocial: null }).some((c) => c.campo.includes("Razão Social"))).toBe(false);
    expect(preencher({ razaoSocial: undefined }).some((c) => c.campo.includes("Razão Social"))).toBe(false);
  });

  it("pessoa física (sem CNPJ): a razão social é o nome completo", () => {
    const pf = DO_AGENTE.filter((c) => c.campo !== "CNPJ [CADASTRO]").concat({
      campo: "CPF",
      valor: "111.444.777-35",
    });
    const r = preencher({ campos: pf, razaoSocial: "NÃO USAR" });
    expect(r.find((c) => c.campo.includes("Razão Social"))?.valor).toBe("Maria Souza Exemplo");
  });

  it("⚠ fora da venda do agente não escreve nada", () => {
    expect(
      preencher({ campos: DO_AGENTE.map((c) => (c.campo === "VENDEDOR" ? { ...c, valor: "Alan" } : c)) }),
    ).toEqual([]);
    expect(
      preencher({
        campos: [
          { campo: "VENDEDOR", valor: "Auto Venda" },
          { campo: "TIPO DE PRODUTO", valor: "Sala de reunião" },
          { campo: "NOME CLIENTE", valor: "Fulano" },
        ],
      }),
    ).toEqual([]);
  });

  it("campo que a lista não tem é ignorado, sem erro", () => {
    const r = preencher({ camposDaLista: LISTA.filter((c) => c.name !== "VENCIMENTO") });
    expect(r.some((c) => c.campo === "VENCIMENTO")).toBe(false);
    expect(r.some((c) => c.campo === "RESPONSÁVEL")).toBe(true);
  });

  it("o sistema marca 'CPF ou CNPJ Preenchidos' quando há documento e o agente esqueceu a caixa", () => {
    const semCaixa = DO_AGENTE.filter((c) => c.campo !== "CPF ou CNPJ Preenchidos");
    expect(preencher({ campos: semCaixa }).find((c) => c.campo === "CPF ou CNPJ Preenchidos")?.valor).toBe(true);
    // Sem CPF nem CNPJ, não há o que marcar.
    const semDocumento = semCaixa.filter((c) => c.campo !== "CNPJ [CADASTRO]");
    expect(preencher({ campos: semDocumento }).some((c) => c.campo === "CPF ou CNPJ Preenchidos")).toBe(false);
  });

  it("caixa que o agente desmarcou de propósito é marcada pelo sistema quando há documento", () => {
    const desmarcada = DO_AGENTE.map((c) => (c.campo === "CPF ou CNPJ Preenchidos" ? { ...c, valor: false } : c));
    expect(preencher({ campos: desmarcada }).find((c) => c.campo === "CPF ou CNPJ Preenchidos")?.valor).toBe(true);
  });

  it("e-mail que não é um e-mail não vira e-mail do responsável", () => {
    const r = preencher({
      campos: DO_AGENTE.map((c) => (c.campo === "E-mail" ? { ...c, valor: "não tenho" } : c)),
    });
    expect(r.some((c) => c.campo === "E-mail do responsável")).toBe(false);
  });
});

describe("cnpjDosCampos", () => {
  it("devolve os 14 dígitos, com ou sem pontuação", () => {
    expect(cnpjDosCampos(DO_AGENTE)).toBe("11222333000181");
    expect(cnpjDosCampos([{ campo: "CNPJ [CADASTRO]", valor: "11222333/0001-81" }])).toBe("11222333000181");
  });

  it("número que não tem 14 dígitos não é CNPJ", () => {
    expect(cnpjDosCampos([{ campo: "CNPJ [CADASTRO]", valor: "123" }])).toBeNull();
    expect(cnpjDosCampos([])).toBeNull();
  });
});

describe("faltamParaOContrato", () => {
  const completa = [
    ...DO_AGENTE,
    ...preencher(),
    { campo: "RAMO DE ATIVIDADE", valor: "Outros serviços" },
  ];

  it("depois do que o sistema preenche, sobra o que só o cliente sabe", () => {
    expect(faltamParaOContrato({ campos: completa, camposDaLista: LISTA })).toEqual([
      "RG / ID / RNE",
      "Endereço Sócio",
      "CPF",
    ]);
  });

  it("a task como o Everton a criou na 14818 está longe de subir ao contrato", () => {
    expect(faltamParaOContrato({ campos: DO_AGENTE, camposDaLista: LISTA })).toEqual([
      "Razão Social",
      "RESPONSÁVEL",
      "E-mail do responsável",
      "RG / ID / RNE",
      "Endereço Sócio",
      "RAMO DE ATIVIDADE",
      "DATA INICIO CONTRATO",
      "DATA DE ENCERRAMENTO CONTRATO",
      "VENCIMENTO",
      "CPF",
    ]);
  });

  it("com tudo na task, não falta nada", () => {
    const tudo = [
      ...completa,
      { campo: "RG / ID / RNE", valor: "1234567 SSP RN" },
      { campo: "CPF", valor: "11144477735" },
      { campo: "📍 Endereço Sócio", valor: "Rua das Palmeiras, 200, Natal - RN" },
    ];
    expect(faltamParaOContrato({ campos: tudo, camposDaLista: LISTA })).toEqual([]);
  });

  it("⚠ cada campo da regra da Base de clientes é cobrado: sem celular, valor, estado civil ou faturamento a task não sobe", () => {
    for (const nome of ["CELULAR", "VALOR CONTRATO", "Estado Civil", "FATURAMENTO"]) {
      const sem = completa.filter((c) => c.campo !== nome);
      expect(faltamParaOContrato({ campos: sem, camposDaLista: LISTA })).toContain(nome);
    }
  });

  it("⚠ 'CPF ou CNPJ Preenchidos' desmarcado não conta: a regra exige a caixa marcada", () => {
    for (const desmarcado of [false, "false", "não"]) {
      const sem = completa.map((c) => (c.campo === "CPF ou CNPJ Preenchidos" ? { ...c, valor: desmarcado } : c));
      expect(faltamParaOContrato({ campos: sem, camposDaLista: LISTA })).toContain("CPF ou CNPJ Preenchidos");
    }
  });

  it("pessoa física não é cobrada pela sede da empresa", () => {
    const pf = DO_AGENTE.filter((c) => c.campo !== "CNPJ [CADASTRO]" && c.campo !== "Sede da Empresa");
    expect(faltamParaOContrato({ campos: pf, camposDaLista: LISTA })).not.toContain("Sede da Empresa");
  });

  it("campo que a lista não tem não é cobrado: não há onde preencher", () => {
    const semRg = LISTA.filter((c) => c.name !== "RG / ID / RNE");
    expect(faltamParaOContrato({ campos: completa, camposDaLista: semRg })).not.toContain("RG / ID / RNE");
  });

  it("fora da venda do agente devolve vazio, e a task não ganha aviso nenhum", () => {
    expect(
      faltamParaOContrato({
        campos: [{ campo: "VENDEDOR", valor: "Alan" }, { campo: "TIPO DE PRODUTO", valor: "Endereço Fiscal Litoral" }],
        camposDaLista: LISTA,
      }),
    ).toEqual([]);
  });
});

describe("avisoDeContratoIncompleto", () => {
  it("lista o que falta e manda o agente falar a verdade ao cliente", () => {
    const t = avisoDeContratoIncompleto(["RG / ID / RNE", "CPF"]);
    expect(t).toContain("RG / ID / RNE, CPF");
    expect(t).toContain("AINDA NÃO sobe sozinha");
    expect(t).toContain("a equipe confirma o envio");
    expect(t).toContain("nota interna");
  });
});
