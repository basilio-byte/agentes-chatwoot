import { describe, expect, it } from "vitest";
import {
  aniversarioNaJanela,
  avisoDePedido,
  diasDesdeOAniversario,
  FOLGA_ANTES_DA_RESERVA_MS,
  lerConfigAniversario,
  TEXTO_CONFIRMACAO_PADRAO,
  textoDeConfirmacao,
  vencimentoDoPedido,
  vendaDoPresente,
} from "./regras";

describe("há quantos dias foi o aniversário", () => {
  it("conta a partir do aniversário deste ano", () => {
    expect(diasDesdeOAniversario("1990-09-22", "2026-09-22")).toBe(0);
    expect(diasDesdeOAniversario("1990-09-15", "2026-09-22")).toBe(7);
    expect(diasDesdeOAniversario("1990-09-14", "2026-09-22")).toBe(8);
  });

  it("aniversário que ainda não chegou este ano conta do ano passado", () => {
    // 23/09 é amanhã: o último foi há 364 dias, e o pedido de hoje não vale.
    expect(diasDesdeOAniversario("1990-09-23", "2026-09-22")).toBe(364);
  });

  it("atravessa a virada do ano", () => {
    expect(diasDesdeOAniversario("1985-12-30", "2027-01-03")).toBe(4);
  });

  it("29/02 vira 28/02 em ano que não é bissexto", () => {
    expect(diasDesdeOAniversario("1992-02-29", "2027-02-28")).toBe(0);
    expect(diasDesdeOAniversario("1992-02-29", "2028-02-29")).toBe(0);
  });

  it("aceita data com hora e recusa o que não é data", () => {
    expect(diasDesdeOAniversario("1990-09-20T00:00:00-03:00", "2026-09-22")).toBe(2);
    expect(diasDesdeOAniversario(null, "2026-09-22")).toBeNull();
    expect(diasDesdeOAniversario("", "2026-09-22")).toBeNull();
    expect(diasDesdeOAniversario("20/09/1990", "2026-09-22")).toBeNull();
  });
});

describe("a janela do presente", () => {
  it("sem data nenhuma no cadastro é outra resposta que fora da janela", () => {
    expect(aniversarioNaJanela([undefined, null, ""], "2026-09-22", 7)).toEqual({ tipo: "semData" });
    expect(aniversarioNaJanela(["1990-01-10"], "2026-09-22", 7)).toEqual({ tipo: "fora" });
  });

  it("vale até N dias DEPOIS do aniversário, nunca antes", () => {
    expect(aniversarioNaJanela(["1990-09-15"], "2026-09-22", 7)).toEqual({
      tipo: "dentro",
      diasDepois: 7,
      aniversario: "15/09",
    });
    // Amanhã é o aniversário: o e-mail ainda não saiu.
    expect(aniversarioNaJanela(["1990-09-23"], "2026-09-22", 7).tipo).toBe("fora");
  });

  it("entre várias pessoas, a que abre a janela", () => {
    expect(
      aniversarioNaJanela([null, "1980-03-01", "1995-09-20"], "2026-09-22", 7),
    ).toEqual({ tipo: "dentro", diasDepois: 2, aniversario: "20/09" });
  });
});

describe("o prazo para liberar o pacote", () => {
  const agora = Date.parse("2026-09-22T12:00:00Z");

  it("é o prazo configurado quando a reserva está longe", () => {
    const inicio = Date.parse("2026-09-25T17:00:00Z");
    expect(vencimentoDoPedido({ agoraMs: agora, prazoHoras: 4, inicioDaReservaMs: inicio }).getTime()).toBe(
      agora + 4 * 3_600_000,
    );
  });

  it("nunca passa de meia hora antes de a reserva começar", () => {
    const inicio = Date.parse("2026-09-22T14:00:00Z");
    expect(vencimentoDoPedido({ agoraMs: agora, prazoHoras: 4, inicioDaReservaMs: inicio }).getTime()).toBe(
      inicio - FOLGA_ANTES_DA_RESERVA_MS,
    );
  });
});

describe("a venda do pacote", () => {
  const desdeMs = Date.parse("2026-09-22T12:00:00Z");
  const filtro = { produtos: [1, 3014], desdeMs };
  const venda = (extra: Record<string, unknown>) => ({
    saleId: 93568,
    product: { id: 1, name: "Pré-Venda Pacote de Horas" },
    amount: 0,
    status: "paid",
    requesterId: 6505,
    createdAt: "2026-09-22T10:30:00-03:00",
    ...extra,
  });

  it("paga, do produto e de R$ 0: libera a reserva, com a pessoa da venda", () => {
    expect(vendaDoPresente([venda({})], filtro)).toEqual({ tipo: "paga", vendaId: 93568, pessoaId: 6505 });
  });

  it("lançada e ainda não paga: esperando", () => {
    expect(vendaDoPresente([venda({ status: "billed" })], filtro)).toEqual({
      tipo: "esperando",
      vendaId: 93568,
      status: "billed",
    });
    expect(vendaDoPresente([venda({ status: "notBilled" })], filtro).tipo).toBe("esperando");
  });

  it("⚠ pacote PAGO pelo cliente não é presente", () => {
    expect(vendaDoPresente([venda({ amount: 450 })], filtro)).toEqual({ tipo: "nenhuma" });
  });

  it("ignora outro produto, venda cancelada e venda anterior ao pedido", () => {
    expect(vendaDoPresente([venda({ product: { id: 77 } })], filtro).tipo).toBe("nenhuma");
    expect(vendaDoPresente([venda({ status: "cancelled" })], filtro).tipo).toBe("nenhuma");
    expect(vendaDoPresente([venda({ createdAt: "2026-09-20T10:00:00-03:00" })], filtro).tipo).toBe("nenhuma");
  });

  it("sem data de criação na resposta, vale o filtro da consulta", () => {
    expect(vendaDoPresente([venda({ createdAt: null })], filtro).tipo).toBe("paga");
  });

  it("a paga vence a que ainda espera, na ordem que vier", () => {
    expect(
      vendaDoPresente([venda({ saleId: 1, status: "billed" }), venda({ saleId: 2 })], filtro),
    ).toEqual({ tipo: "paga", vendaId: 2, pessoaId: 6505 });
  });

  it("o produto da SEATECH também conta", () => {
    expect(vendaDoPresente([venda({ product: { id: 3014 } })], filtro).tipo).toBe("paga");
  });
});

describe("textos", () => {
  const pedido = { salaNome: "Sala de Reunião 03", salaId: 2107, data: "2026-09-25", inicio: "14:00", fim: "16:00" };

  it("a confirmação troca os marcadores pelos dados da reserva", () => {
    const texto = textoDeConfirmacao(TEXTO_CONFIRMACAO_PADRAO, pedido);
    expect(texto).toContain("Sala de Reunião 03, no dia 25/09, das 14:00 às 16:00");
    expect(texto).not.toMatch(/\{\w+\}/);
  });

  it("sem o nome da sala, diz o número dela", () => {
    expect(textoDeConfirmacao("{sala}", { ...pedido, salaNome: null })).toBe("sala 2107");
  });

  it("o aviso à equipe diz o que fazer e que NÃO precisa reservar", () => {
    const texto = avisoDePedido({
      pedido,
      clienteId: 5872,
      clienteNome: "Cliente de Teste",
      aniversario: "20/09",
      venceEm: "22/09/2026, 16:00",
      linkDaConversa: "https://chatwoot.test/app/accounts/1/conversations/99",
    });
    expect(texto).toContain("Conexa 5872");
    expect(texto).toContain("fature a cobrança de R$ 0");
    expect(texto).toContain("não precisa reservar");
    expect(texto).toContain("conversations/99");
  });
});

describe("configuração", () => {
  it("sem nada gravado, os padrões do Diego", () => {
    const config = lerConfigAniversario(undefined);
    expect(config).toMatchObject({
      avisar: [],
      caixaDoAviso: 31,
      atendente: "Diego",
      diasDepois: 7,
      horas: 2,
      produtos: [1, 3014],
    });
  });

  it("lê os telefones salvos e descarta o que não é telefone", () => {
    const config = lerConfigAniversario({
      avisar: [
        { nome: "Diego", telefone: "+5584999999999" },
        { nome: "Quebrado", telefone: "abc" },
      ],
    });
    expect(config.avisar).toEqual([{ nome: "Diego", telefone: "+5584999999999" }]);
  });

  it("config quebrada cai nos padrões em vez de parar o sistema", () => {
    expect(lerConfigAniversario({ prazoHoras: "muito" }).prazoHoras).toBe(4);
  });
});
