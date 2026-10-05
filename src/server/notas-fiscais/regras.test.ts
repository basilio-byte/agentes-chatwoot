import { describe, expect, it } from "vitest";
import { notasFiscaisConfigSchema, type NotasFiscaisConfig } from "./config";
import {
  centavos,
  chaveDaNota,
  classificarItem,
  codigoDoItem,
  decidir,
  decisaoDeFora,
  descricaoDaNota,
  desdeQuando,
  ehNomeDeSala,
  formatarReais,
  lerCobranca,
  lerVenda,
  motivoParaFicarFora,
  type CobrancaLida,
  type ItemClassificado,
} from "./regras";

const config = (parcial: Partial<NotasFiscaisConfig> = {}): NotasFiscaisConfig =>
  notasFiscaisConfigSchema.parse({
    codigos: { "10": "03.03.02", "3": "10.05.01", "23": "11.04.01" },
    codigoReservaDeSala: "03.03.02",
    ...parcial,
  });

/** Cobrança paga no formato de `GET /charges` (campos conferidos na API real). */
const cobrancaBruta = (extra: Record<string, unknown> = {}) => ({
  chargeId: 900,
  companyId: 3,
  customerId: 77,
  type: "contractual",
  status: "paid",
  amount: 149,
  currentAmount: 149,
  paidAmount: 149,
  paymentDate: "2026-10-05",
  competenceDate: "2026-10-01",
  createdAt: "2026-09-24T09:43:30-03:00",
  hasISSRetention: false,
  ISSAmount: 0,
  taxInvoiceNumber: null,
  salesIds: [1, 2],
  ...extra,
});

const cobranca = (extra: Record<string, unknown> = {}): CobrancaLida =>
  lerCobranca(cobrancaBruta(extra))!;

const item = (parcial: Partial<ItemClassificado>): ItemClassificado => ({
  id: 1,
  produtoId: 2970,
  nome: "EV - Endereço Fiscal Batial Mensal",
  quantidade: 1,
  valorCentavos: 14900,
  status: "paid",
  contratoId: null,
  categoriaId: 10,
  origem: "categoria",
  ...parcial,
});

describe("leitura da API do Conexa", () => {
  it("lê a cobrança em centavos, com os campos fiscais que o n8n ignorava", () => {
    const c = lerCobranca(
      cobrancaBruta({ amount: 140, currentAmount: 142.94, paidAmount: 142.94, hasISSRetention: true, ISSAmount: 7 }),
    )!;
    expect(c).toMatchObject({
      id: 900,
      empresaId: 3,
      clienteId: 77,
      valorCentavos: 14000,
      valorAtualCentavos: 14294,
      valorPagoCentavos: 14294,
      quitadaEm: "2026-10-05",
      competencia: "2026-10-01",
      criadaEm: "2026-09-24",
      retemIss: true,
      valorIssCentavos: 700,
      vendasIds: [1, 2],
    });
  });

  it("recusa cobrança sem id, empresa, cliente ou valor", () => {
    expect(lerCobranca(cobrancaBruta({ chargeId: undefined }))).toBeNull();
    expect(lerCobranca(cobrancaBruta({ companyId: null }))).toBeNull();
    expect(lerCobranca(cobrancaBruta({ amount: "abc" }))).toBeNull();
  });

  it("lê a venda com o produto aninhado (formato de GET /sale/:id)", () => {
    expect(
      lerVenda({
        saleId: 5,
        product: { id: 2880, name: "[SEAWAY] - SALA DE ATENDIMENTO 02 - 3 pessoas" },
        quantity: 1,
        amount: 0,
        status: "deductedFromQuota",
        contractId: null,
      }),
    ).toEqual({
      id: 5,
      produtoId: 2880,
      nome: "[SEAWAY] - SALA DE ATENDIMENTO 02 - 3 pessoas",
      quantidade: 1,
      valorCentavos: 0,
      status: "deductedFromQuota",
      contratoId: null,
    });
  });

  it("centavos não sofre com ponto flutuante", () => {
    expect(centavos(0.1 + 0.2)).toBe(30);
    expect(centavos(113.86)).toBe(11386);
    expect(formatarReais(14294)).toMatch(/142,94/);
  });
});

describe("classificação de cada item", () => {
  it("produto com categoria usa a categoria", () => {
    expect(classificarItem(lerVenda({ saleId: 1, product: { id: 2970, name: "EV" }, amount: 1 })!, { categoriaId: 10 }))
      .toMatchObject({ origem: "categoria", categoriaId: 10 });
  });

  it("⚠ item que não existe no cadastro e tem nome de sala é reserva de sala", () => {
    const venda = lerVenda({ saleId: 2, product: { id: 2880, name: "[SEAWAY] - SALA DE REUNIÃO 04 - 8 Pessoas" }, amount: 105 })!;
    expect(classificarItem(venda, null).origem).toBe("reserva de sala");
  });

  it("⚠ item que não existe no cadastro SEM nome de sala não vira palpite", () => {
    const venda = lerVenda({ saleId: 3, product: { id: 999, name: "Produto apagado" }, amount: 50 })!;
    expect(classificarItem(venda, null).origem).toBe("sem categoria");
  });

  it("nome de sala só vale quando o produto não existe — produto com categoria manda", () => {
    const venda = lerVenda({ saleId: 4, product: { id: 1, name: "[X] - algo" }, amount: 1 })!;
    expect(classificarItem(venda, { categoriaId: 23 }).origem).toBe("categoria");
  });

  it("reconhece o padrão de nome das salas", () => {
    expect(ehNomeDeSala("[SEBRAE] - AUDITÓRIO EMPREENDA")).toBe(true);
    expect(ehNomeDeSala("[SEAWAY] - SALA DE ATENDIMENTO 01 - 3 pessoas")).toBe(true);
    expect(ehNomeDeSala("Contrato: Sala 01 - Sebrae")).toBe(false);
    expect(ehNomeDeSala("[SEAWAY]")).toBe(false);
  });

  it("o código vem da tabela; categoria fora dela é null, nunca um palpite", () => {
    expect(codigoDoItem({ origem: "categoria", categoriaId: 3 }, config())).toBe("10.05.01");
    expect(codigoDoItem({ origem: "categoria", categoriaId: 8 }, config())).toBeNull();
    expect(codigoDoItem({ origem: "reserva de sala", categoriaId: null }, config())).toBe("03.03.02");
    expect(codigoDoItem({ origem: "reserva de sala", categoriaId: null }, config({ codigoReservaDeSala: "" }))).toBeNull();
    expect(codigoDoItem({ origem: "sem categoria", categoriaId: null }, config())).toBeNull();
  });
});

describe("decisão", () => {
  it("cobrança paga com todos os itens classificados fica pronta", () => {
    const d = decidir(cobranca(), [item({}), item({ id: 2, valorCentavos: 0, nome: "[SEAWAY] - SALA", origem: "reserva de sala", categoriaId: null })], config(), "quitada");
    expect(d.situacao).toBe("PRONTA");
    expect(d.notas).toEqual([
      {
        codigo: "03.03.02",
        valorCentavos: 14900,
        descricao: "EV - Endereço Fiscal Batial Mensal",
        chave: "conexa-900-030302",
        vendas: [1],
      },
    ]);
    expect(d.observacoes).toContain("1 item(ns) de R$ 0 (descontados do pacote) fora da nota");
  });

  it("⚠ dois códigos na mesma cobrança viram DUAS notas — uma NFS-e tem um código só", () => {
    const d = decidir(
      cobranca({ amount: 2158 }),
      [
        item({ id: 1, nome: "Contrato: Sala 05 - Ayrton Senna", categoriaId: 3, valorCentavos: 215000 }),
        item({ id: 2, nome: "Seabox Básico - Encomenda", categoriaId: 23, valorCentavos: 800 }),
      ],
      config(),
      "quitada",
    );
    expect(d.situacao).toBe("PRONTA");
    expect(d.notas.map((n) => [n.codigo, n.valorCentavos, n.chave])).toEqual([
      ["10.05.01", 215000, "conexa-900-100501"],
      ["11.04.01", 800, "conexa-900-110401"],
    ]);
  });

  it("⚠ item cobrado sem código segura a cobrança INTEIRA, dizendo qual", () => {
    const d = decidir(
      cobranca({ amount: 1349 }),
      [item({}), item({ id: 2, nome: "Contrato: Sala 01 - Nações", categoriaId: 8, valorCentavos: 120000 })],
      config(),
      "quitada",
    );
    expect(d.situacao).toBe("AGUARDANDO_CLASSIFICACAO");
    expect(d.notas).toEqual([]);
    expect(d.motivo).toContain('"Contrato: Sala 01 - Nações" (categoria 8 sem código)');
  });

  it("item de R$ 0 sem código não segura nada", () => {
    const d = decidir(cobranca(), [item({}), item({ id: 2, valorCentavos: 0, categoriaId: 99 })], config(), "quitada");
    expect(d.situacao).toBe("PRONTA");
  });

  it("vendas que não somam a cobrança vão para conferência, com as notas montadas", () => {
    const d = decidir(cobranca({ amount: 160 }), [item({})], config(), "quitada");
    expect(d.situacao).toBe("CONFERIR");
    expect(d.motivo).toMatch(/somam R\$\s?149,00 e a cobrança é de R\$\s?160,00/);
    expect(d.notas).toHaveLength(1);
  });

  it("retenção de ISS vai para conferência", () => {
    const d = decidir(cobranca({ hasISSRetention: true, ISSAmount: 7.45 }), [item({})], config(), "quitada");
    expect(d.situacao).toBe("CONFERIR");
    expect(d.motivo).toMatch(/retém ISS/);
  });

  it("juros, competência em outro mês e itens zerados viram observação, sem mudar a decisão", () => {
    const d = decidir(
      cobranca({ amount: 149, currentAmount: 152.08, paidAmount: 152.08, competenceDate: "2026-09-01" }),
      [item({})],
      config(),
      "quitada",
    );
    expect(d.situacao).toBe("PRONTA");
    expect(d.observacoes[0]).toMatch(/paga R\$\s?152,08 sobre R\$\s?149,00 \(juros\/multa\)/);
    expect(d.observacoes[1]).toBe("competência 09/2026, paga em 05/10/2026");
  });

  describe("regras por cliente (no lugar dos ids escritos nos If do n8n)", () => {
    const comRegra = (regra: "antes" | "nunca") =>
      config({ clientes: [{ clienteId: 77, regra, observacao: "" }] });

    it("'nunca' não tem nota automática", () => {
      expect(decidir(cobranca(), [item({})], comRegra("nunca"), "quitada").situacao).toBe("FORA_DA_REGRA");
    });

    it("'antes': a nota sai na geração da cobrança", () => {
      const gerada = decidir(cobranca({ status: "unpaid", paidAmount: null, paymentDate: null }), [item({})], comRegra("antes"), "gerada");
      expect(gerada.situacao).toBe("PRONTA");
    });

    it("⚠ 'antes' visto só depois de pago (gerada e paga entre duas rodadas) ainda leva a nota", () => {
      const paga = decidir(cobranca(), [item({})], { ...comRegra("antes"), inicio: "2026-09-20" }, "quitada");
      expect(paga.situacao).toBe("PRONTA");
      expect(paga.observacoes).toContain("cliente com nota na geração, mas a cobrança só foi vista já paga");
    });

    it("⚠ 'antes' gerada ANTES do início teve a nota pelo fluxo antigo: o pagamento não emite de novo", () => {
      const paga = decidir(cobranca(), [item({})], { ...comRegra("antes"), inicio: "2026-10-01" }, "quitada");
      expect(paga.situacao).toBe("FORA_DA_REGRA");
      expect(paga.motivo).toMatch(/gerada antes do início/);
    });

    it("cobrança gerada de cliente sem regra 'antes' não tem nota", () => {
      expect(decidir(cobranca({ status: "unpaid" }), [item({})], config(), "gerada").situacao).toBe("FORA_DA_REGRA");
    });
  });

  it("as regras que não dependem dos itens decidem sem ler as vendas", () => {
    const nunca = config({ clientes: [{ clienteId: 77, regra: "nunca", observacao: "" }] });
    expect(motivoParaFicarFora(cobranca(), nunca, "quitada")).toMatch(/sem nota automática/);
    expect(motivoParaFicarFora(cobranca(), config(), "quitada")).toBeNull();
    expect(decisaoDeFora(cobranca({ paidAmount: 152.08 }), "x")).toMatchObject({
      situacao: "FORA_DA_REGRA",
      notas: [],
      observacoes: [expect.stringMatching(/juros\/multa/)],
    });
  });

  it("cobrança que não está no estado do evento fica fora", () => {
    expect(decidir(cobranca({ status: "cancelled" }), [item({})], config(), "quitada").motivo).toBe('a cobrança está "cancelled"');
  });

  it("nota já registrada no próprio Conexa não é emitida de novo", () => {
    const d = decidir(cobranca({ taxInvoiceNumber: 4321 }), [item({})], config(), "quitada");
    expect(d.situacao).toBe("FORA_DA_REGRA");
    expect(d.motivo).toMatch(/4321/);
  });

  it("cobrança sem venda nenhuma vai para conferência, não some", () => {
    const d = decidir(cobranca({ salesIds: [] }), [], config(), "quitada");
    expect(d.situacao).toBe("CONFERIR");
    expect(d.motivo).toBe("a cobrança veio sem vendas");
  });
});

describe("nota", () => {
  it("a chave é estável e cabe nos 36 caracteres da Spedy", () => {
    expect(chaveDaNota(31062, "03.03.02")).toBe("conexa-31062-030302");
    expect(chaveDaNota(99_999_999, "10.05.01").length).toBeLessThanOrEqual(36);
  });

  it("a descrição tem um item por linha, com a quantidade quando passa de um", () => {
    expect(descricaoDaNota([{ nome: "Impressão", quantidade: 30 }, { nome: "Limpeza", quantidade: 1 }])).toBe(
      "30x Impressão\nLimpeza",
    );
    expect(descricaoDaNota([{ nome: "x".repeat(2000), quantidade: 1 }]).length).toBe(1000);
  });
});

describe("janela da rodada", () => {
  it("começa no início configurado, mas nunca mais de 7 dias para trás nem no futuro", () => {
    expect(desdeQuando("2026-10-05", null)).toBe("2026-10-05");
    expect(desdeQuando("2026-10-05", "2026-10-03")).toBe("2026-10-03");
    expect(desdeQuando("2026-10-05", "2026-09-01")).toBe("2026-09-28");
    expect(desdeQuando("2026-10-05", "2026-10-09")).toBe("2026-10-05");
  });
});
