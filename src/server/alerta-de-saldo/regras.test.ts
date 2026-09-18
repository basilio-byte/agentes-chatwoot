import { describe, expect, it } from "vitest";
import type { LeituraDeSaldo } from "@/server/consumo/saldo";
import {
  decidirAviso,
  destinatariosSalvos,
  dolar,
  formatarTelefone,
  INTERVALO_ENTRE_AVISOS_MS,
  lerDestinatarios,
  lerLimite,
  MAX_DESTINATARIOS,
  mesmoNumero,
  normalizarTelefone,
  textoDoAviso,
  type EstadoDoAlerta,
} from "./regras";

const AGORA = new Date("2026-09-18T13:00:00Z");
const HORA = 60 * 60_000;

const lido = (saldoUsd: number, origem: "conta" | "chave" = "conta"): LeituraDeSaldo => ({
  estado: "lido",
  origem,
  saldoUsd,
  usadoUsd: 500,
  compradoUsd: 500 + saldoUsd,
  lidoEm: AGORA,
});

const semEpisodio: EstadoDoAlerta = { abaixoDesde: null, avisadoEm: null, avisadoTipo: null };

const decidir = (
  leitura: LeituraDeSaldo,
  estado: EstadoDoAlerta = semEpisodio,
  extra: Partial<{ ligado: boolean; limiteUsd: number; temDestinatarios: boolean }> = {},
) =>
  decidirAviso({
    leitura,
    ligado: true,
    limiteUsd: 20,
    temDestinatarios: true,
    estado,
    agora: AGORA,
    ...extra,
  });

describe("normalizarTelefone", () => {
  it("aceita o número brasileiro do jeito que a equipe digita", () => {
    expect(normalizarTelefone("(84) 99999-1234")).toBe("+5584999991234");
    expect(normalizarTelefone("84 99999 1234")).toBe("+5584999991234");
    expect(normalizarTelefone("+55 84 99999-1234")).toBe("+5584999991234");
    expect(normalizarTelefone("5584999991234")).toBe("+5584999991234");
    // Fixo, e celular sem o nono dígito: ficam como vieram.
    expect(normalizarTelefone("(84) 3222-1234")).toBe("+558432221234");
    expect(normalizarTelefone("558499991234")).toBe("+558499991234");
  });

  it("⚠ onze dígitos começando com 55 é o DDD de Santa Maria, não o país", () => {
    expect(normalizarTelefone("(55) 99999-1234")).toBe("+5555999991234");
    expect(normalizarTelefone("+55 55 99999-1234")).toBe("+5555999991234");
  });

  it("estrangeiro só com + na frente", () => {
    expect(normalizarTelefone("+1 415 555 0100")).toBe("+14155550100");
    expect(normalizarTelefone("+351 912 345 678")).toBe("+351912345678");
  });

  it("recusa o que não é telefone", () => {
    expect(normalizarTelefone("")).toBeNull();
    expect(normalizarTelefone("abc")).toBeNull();
    expect(normalizarTelefone("99999-1234")).toBeNull(); // sem DDD
    expect(normalizarTelefone("+55 84 999")).toBeNull();
    expect(normalizarTelefone("+12")).toBeNull();
  });

  it("formata para a tela e volta igual", () => {
    expect(formatarTelefone("+5584999991234")).toBe("+55 84 99999-1234");
    expect(formatarTelefone("+558432221234")).toBe("+55 84 3222-1234");
    expect(normalizarTelefone(formatarTelefone("+5584999991234"))).toBe("+5584999991234");
    expect(formatarTelefone("+14155550100")).toBe("+14155550100");
  });

  it("mesmo número com e sem o nono dígito", () => {
    expect(mesmoNumero("+558499991234", "+5584999991234")).toBe(true);
    expect(mesmoNumero("5584999991234", "+5584999991234")).toBe(true);
    expect(mesmoNumero("+5584999991235", "+5584999991234")).toBe(false);
    expect(mesmoNumero("+14155550100", "14155550100")).toBe(true);
  });
});

describe("lerDestinatarios", () => {
  it("lê as linhas e ignora as vazias", () => {
    const lido = lerDestinatarios(
      ["Pessoa Um", "", "Pessoa Dois"],
      ["(84) 99999-1234", "", "84 98888-4321"],
    );
    expect(lido).toEqual({
      destinatarios: [
        { nome: "Pessoa Um", telefone: "+5584999991234" },
        { nome: "Pessoa Dois", telefone: "+5584988884321" },
      ],
    });
  });

  it("sem nome, a pessoa aparece pelo telefone", () => {
    expect(lerDestinatarios([""], ["84 99999-1234"])).toEqual({
      destinatarios: [{ nome: "+55 84 99999-1234", telefone: "+5584999991234" }],
    });
  });

  it("⚠ linha com nome e sem telefone é recusada, não some em silêncio", () => {
    expect(lerDestinatarios(["Pessoa Um"], [""])).toEqual({ erro: "Falta o telefone de Pessoa Um." });
    expect("erro" in lerDestinatarios(["Pessoa Um"], ["1234"])).toBe(true);
  });

  it("o mesmo número duas vezes, mesmo com e sem o nono dígito, é recusado", () => {
    const lido = lerDestinatarios(["A", "B"], ["84 99999-1234", "+55 84 9999-1234"]);
    expect(lido).toEqual({ erro: "O telefone de B é o mesmo de A." });
  });

  it(`no máximo ${MAX_DESTINATARIOS} pessoas`, () => {
    const n = MAX_DESTINATARIOS + 1;
    const nomes = Array.from({ length: n }, (_, i) => `P${i}`);
    const telefones = Array.from({ length: n }, (_, i) => `84 9${String(1000_0000 + i)}`);
    expect("erro" in lerDestinatarios(nomes, telefones)).toBe(true);
  });

  it("o que está no banco é relido sem confiar na forma", () => {
    expect(
      destinatariosSalvos([
        { nome: "A", telefone: "+5584999991234" },
        { nome: "B" },
        "lixo",
        { telefone: "84 98888-4321" },
      ]),
    ).toEqual([
      { nome: "A", telefone: "+5584999991234" },
      { nome: "+55 84 98888-4321", telefone: "+5584988884321" },
    ]);
    expect(destinatariosSalvos(null)).toEqual([]);
  });
});

describe("lerLimite", () => {
  it("aceita vírgula, ponto e o US$ da frente", () => {
    expect(lerLimite("20")).toBe(20);
    expect(lerLimite("20,50")).toBe(20.5);
    expect(lerLimite("US$ 15.25")).toBe(15.25);
  });

  it("recusa zero, negativo e texto", () => {
    expect(lerLimite("0")).toBeNull();
    expect(lerLimite("-5")).toBeNull();
    expect(lerLimite("vinte")).toBeNull();
    expect(lerLimite("")).toBeNull();
  });
});

describe("decidirAviso", () => {
  it("acima do limite não avisa, e encerra o episódio", () => {
    expect(decidir(lido(76.98))).toEqual({ acao: "normalizar", saldoUsd: 76.98 });
  });

  it("abaixo do limite, a primeira vez, avisa e começa o episódio", () => {
    expect(decidir(lido(18.42))).toEqual({
      acao: "avisar",
      tipo: "BAIXO",
      saldoUsd: 18.42,
      origem: "conta",
      iniciaEpisodio: true,
    });
  });

  it("o limite é estrito: exatamente no limite não é baixo", () => {
    expect(decidir(lido(20)).acao).toBe("normalizar");
    expect(decidir(lido(29), semEpisodio, { limiteUsd: 30 }).acao).toBe("avisar");
  });

  it("dentro das 24 h do último aviso, espera", () => {
    const avisadoEm = new Date(AGORA.getTime() - 5 * HORA);
    const decisao = decidir(lido(17), {
      abaixoDesde: avisadoEm,
      avisadoEm,
      avisadoTipo: "BAIXO",
    });
    expect(decisao).toEqual({
      acao: "aguardar",
      saldoUsd: 17,
      proximoEm: new Date(avisadoEm.getTime() + INTERVALO_ENTRE_AVISOS_MS),
    });
  });

  it("passadas 24 h, avisa de novo, sem começar outro episódio", () => {
    const avisadoEm = new Date(AGORA.getTime() - 24 * HORA);
    const decisao = decidir(lido(12), { abaixoDesde: avisadoEm, avisadoEm, avisadoTipo: "BAIXO" });
    expect(decisao).toMatchObject({ acao: "avisar", tipo: "BAIXO", iniciaEpisodio: false });
  });

  it("⚠ zerou dentro das 24 h: avisa na hora — é quando os agentes param", () => {
    const avisadoEm = new Date(AGORA.getTime() - HORA);
    const estado: EstadoDoAlerta = { abaixoDesde: avisadoEm, avisadoEm, avisadoTipo: "BAIXO" };
    expect(decidir(lido(0), estado)).toMatchObject({ acao: "avisar", tipo: "ZERADO" });
    expect(decidir(lido(-0.12), estado)).toMatchObject({ acao: "avisar", tipo: "ZERADO" });
  });

  it("zerado e já avisado como zerado: espera as 24 h como qualquer outro", () => {
    const avisadoEm = new Date(AGORA.getTime() - HORA);
    expect(
      decidir(lido(0), { abaixoDesde: avisadoEm, avisadoEm, avisadoTipo: "ZERADO" }).acao,
    ).toBe("aguardar");
  });

  it("recarregou mas continua abaixo: não avisa de novo antes das 24 h", () => {
    const avisadoEm = new Date(AGORA.getTime() - HORA);
    expect(
      decidir(lido(10), { abaixoDesde: avisadoEm, avisadoEm, avisadoTipo: "ZERADO" }).acao,
    ).toBe("aguardar");
  });

  it("⚠ leitura que falha nunca vira aviso", () => {
    const erro: LeituraDeSaldo = { estado: "erro", motivo: "timeout", lidoEm: AGORA };
    const indisponivel: LeituraDeSaldo = {
      estado: "indisponivel",
      motivo: "sem chave de gestão",
      lidoEm: AGORA,
    };
    expect(decidir(erro)).toEqual({
      acao: "ignorar",
      falha: true,
      motivo: "não consegui saber o saldo: timeout",
    });
    expect(decidir(indisponivel)).toMatchObject({ acao: "ignorar", falha: true });
    expect(decidir({ estado: "sem_chave" })).toMatchObject({ acao: "ignorar", falha: true });
  });

  it("desligado ou sem ninguém cadastrado não avisa, e não é falha", () => {
    expect(decidir(lido(5), semEpisodio, { ligado: false })).toMatchObject({
      acao: "ignorar",
      falha: false,
    });
    expect(decidir(lido(5), semEpisodio, { temDestinatarios: false })).toMatchObject({
      acao: "ignorar",
      falha: false,
    });
  });
});

describe("textoDoAviso", () => {
  it("dólar com duas casas e sem espaço inquebrável", () => {
    expect(dolar(18.4249)).toBe("US$ 18,42");
    expect(dolar(1234.5)).toBe("US$ 1.234,50");
    expect(dolar(-0.12)).toBe("US$ -0,12");
  });

  it("saldo baixo diz quanto resta, o limite, quanto dura e onde recarregar", () => {
    const texto = textoDoAviso({
      tipo: "BAIXO",
      saldoUsd: 18.42,
      limiteUsd: 20,
      origem: "conta",
      gastoDiarioUsd: 0.8171,
      diasDaMedia: 7,
    });
    expect(texto).toContain("Restam US$ 18,42, abaixo do limite de alerta de US$ 20,00.");
    expect(texto).toContain("(US$ 0,82 por dia), dura cerca de 22 dias.");
    expect(texto).toContain("https://openrouter.ai/settings/credits");
    expect(texto).toContain("Repete a cada 24 h");
  });

  it("sem gasto medido, não promete duração", () => {
    const texto = textoDoAviso({ tipo: "BAIXO", saldoUsd: 18, limiteUsd: 20, gastoDiarioUsd: 0 });
    expect(texto).not.toContain("dura");
  });

  it("o teto da chave não se passa por saldo da conta", () => {
    const texto = textoDoAviso({ tipo: "BAIXO", saldoUsd: 5, limiteUsd: 20, origem: "chave" });
    expect(texto).toContain("do teto da chave usada pelos agentes");
  });

  it("zerado diz que os agentes já pararam", () => {
    const texto = textoDoAviso({ tipo: "ZERADO", saldoUsd: 0, limiteUsd: 20 });
    expect(texto).toContain("ZERADO");
    expect(texto).toContain("já não conseguem responder");
  });

  it("o teste diz quem mandou, e não inventa saldo quando a leitura falhou", () => {
    expect(
      textoDoAviso({ tipo: "TESTE", saldoUsd: 76.98, limiteUsd: 20, autor: "Pessoa Um" }),
    ).toContain("Mandado por Pessoa Um pelo painel. Saldo agora: US$ 76,98.");
    const semSaldo = textoDoAviso({
      tipo: "TESTE",
      saldoUsd: null,
      limiteUsd: 20,
      motivoSemSaldo: "timeout",
    });
    expect(semSaldo).toContain("Não consegui ler o saldo agora (timeout).");
    expect(semSaldo).not.toContain("US$ 0");
  });
});
