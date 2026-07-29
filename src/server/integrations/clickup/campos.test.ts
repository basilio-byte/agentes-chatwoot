import { describe, expect, it } from "vitest";
import { converterValor, prepararCampos, resolverCampo } from "./campos";
import type { ClickUpCampoPersonalizado } from "./tipos";

const campo = (
  parcial: Partial<ClickUpCampoPersonalizado> & { name: string; type: string },
): ClickUpCampoPersonalizado => ({ id: `f-${parcial.name}`, ...parcial });

const CAMPOS: ClickUpCampoPersonalizado[] = [
  campo({ name: "CPF", type: "short_text" }),
  campo({ name: "E-mail", type: "email" }),
  campo({ name: "Valor", type: "currency" }),
  campo({ name: "Início do contrato", type: "date" }),
  campo({ name: "Ativo", type: "checkbox" }),
  campo({
    name: "Periodicidade",
    type: "drop_down",
    type_config: {
      options: [
        { id: "op-mensal", name: "Mensal" },
        { id: "op-anual", name: "Anual" },
      ],
    },
  }),
  campo({
    name: "Etiquetas",
    type: "labels",
    type_config: {
      options: [
        { id: "lb-novo", label: "Novo" },
        { id: "lb-vip", label: "VIP" },
      ],
    },
  }),
  campo({ name: "Total calculado", type: "formula" }),
];

describe("resolverCampo", () => {
  it("casa por id, por nome exato e ignorando acento e caixa", () => {
    expect(resolverCampo("f-CPF", CAMPOS)).toMatchObject({ tipo: "achado" });
    expect(resolverCampo("cpf", CAMPOS)).toMatchObject({ tipo: "achado" });
    expect(resolverCampo("inicio do contrato", CAMPOS)).toMatchObject({
      tipo: "achado",
      campo: { name: "Início do contrato" },
    });
  });

  it("casa por trecho quando não há nome exato", () => {
    expect(resolverCampo("período", CAMPOS)).toMatchObject({ tipo: "nenhum" });
    expect(resolverCampo("Periodic", CAMPOS)).toMatchObject({
      tipo: "achado",
      campo: { name: "Periodicidade" },
    });
  });

  it("devolve ambiguidade em vez de escolher sozinho", () => {
    const dois = [
      campo({ name: "Valor mensal", type: "number" }),
      campo({ name: "Valor anual", type: "number" }),
    ];

    expect(resolverCampo("valor", dois)).toMatchObject({
      tipo: "ambiguo",
      candidatos: ["Valor mensal", "Valor anual"],
    });
  });
});

describe("converterValor", () => {
  const de = (nome: string) => CAMPOS.find((c) => c.name === nome)!;

  it("texto passa direto", () => {
    expect(converterValor(de("CPF"), "383.570.368-48")).toEqual({
      ok: true,
      valor: "383.570.368-48",
    });
  });

  it("moeda aceita o que o cliente falou, com R$ e vírgula", () => {
    // "R$ 119,00/mês" é como a informação chega numa conversa.
    expect(converterValor(de("Valor"), "R$ 119,00")).toEqual({ ok: true, valor: 119 });
    expect(converterValor(de("Valor"), "1.250,50")).toEqual({ ok: true, valor: 1250.5 });
    expect(converterValor(de("Valor"), 119)).toEqual({ ok: true, valor: 119 });
  });

  it("moeda sem número vira erro em vez de zero silencioso", () => {
    // Number("") é 0: sem guarda, "a combinar" gravaria R$ 0,00.
    for (const texto of ["combinar", "a combinar", "R$", ""]) {
      expect(converterValor(de("Valor"), texto).ok, texto).toBe(false);
    }
  });

  it("data vira milissegundos", () => {
    expect(converterValor(de("Início do contrato"), "2026-08-01")).toEqual({
      ok: true,
      valor: Date.parse("2026-08-01"),
    });
    expect(converterValor(de("Início do contrato"), "amanhã").ok).toBe(false);
  });

  it("checkbox entende sim e não em português", () => {
    expect(converterValor(de("Ativo"), "sim")).toEqual({ ok: true, valor: true });
    expect(converterValor(de("Ativo"), "Não")).toEqual({ ok: true, valor: false });
    expect(converterValor(de("Ativo"), true)).toEqual({ ok: true, valor: true });
  });

  it("seleção converte o rótulo no id da opção — que o agente não tem como saber", () => {
    expect(converterValor(de("Periodicidade"), "Mensal")).toEqual({
      ok: true,
      valor: "op-mensal",
    });
    expect(converterValor(de("Periodicidade"), "mensal")).toEqual({
      ok: true,
      valor: "op-mensal",
    });
  });

  it("opção inexistente devolve as opções válidas", () => {
    const r = converterValor(de("Periodicidade"), "Semanal");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toContain("Mensal, Anual");
  });

  it("labels aceita um ou vários e usa 'label' como rótulo", () => {
    expect(converterValor(de("Etiquetas"), "VIP")).toEqual({
      ok: true,
      valor: ["lb-vip"],
    });
    expect(converterValor(de("Etiquetas"), ["Novo", "VIP"])).toEqual({
      ok: true,
      valor: ["lb-novo", "lb-vip"],
    });
  });

  it("campo calculado recusa escrita em vez de deixar a API estourar", () => {
    const r = converterValor(de("Total calculado"), "10");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toContain("formula");
  });
});

describe("prepararCampos", () => {
  it("monta o lote no formato do corpo da API", () => {
    const { prontos, problemas } = prepararCampos(
      [
        { campo: "CPF", valor: "383.570.368-48" },
        { campo: "Periodicidade", valor: "Mensal" },
        { campo: "Valor", valor: "R$ 119,00" },
      ],
      CAMPOS,
    );

    expect(problemas).toEqual([]);
    expect(prontos).toEqual([
      { id: "f-CPF", value: "383.570.368-48" },
      { id: "f-Periodicidade", value: "op-mensal" },
      { id: "f-Valor", value: 119 },
    ]);
  });

  it("nome errado vira problema com a lista de campos que existem", () => {
    const { prontos, problemas } = prepararCampos(
      [{ campo: "Estado Civil", valor: "Solteiro" }],
      CAMPOS,
    );

    expect(prontos).toEqual([]);
    expect(problemas[0].motivo).toContain("CPF");
  });

  it("um campo ruim não contamina os bons — quem chama decide abortar", () => {
    const { prontos, problemas } = prepararCampos(
      [
        { campo: "CPF", valor: "123" },
        { campo: "Inexistente", valor: "x" },
      ],
      CAMPOS,
    );

    expect(prontos).toHaveLength(1);
    expect(problemas).toHaveLength(1);
  });

  it("lista sem campos personalizados explica isso em vez de listar nada", () => {
    const { problemas } = prepararCampos([{ campo: "CPF", valor: "1" }], []);
    expect(problemas[0].motivo).toContain("não tem campos personalizados");
  });
});
