import { describe, expect, it } from "vitest";
import { atributosParaOContato, type DefinicaoDeAtributo } from "./regras";

const definicoes: DefinicaoDeAtributo[] = [
  { chave: "tipo_de_produto_novo", tipo: "list", opcoes: ["Sala de atendimento", "Sala de reunião", "Sala Privativa "] },
  { chave: "categoria_de_servio", tipo: "list", opcoes: ["Serviços de Endereço", "Serviços de Espaço"] },
  { chave: "canal", tipo: "list", opcoes: ["Site", "Indicação"] },
];

const campos = [
  { campo: "NOME CLIENTE", valor: "Jimmy Carvalho Pires de Medeiros" },
  { campo: "CELULAR", valor: "+55 84 88219211" },
  { campo: "TIPO DE PRODUTO", valor: "Sala de atendimento" },
  { campo: "Tipo de Atendimento", valor: "Reserva de Salas" },
  { campo: "CATEGORIA DE SERVIÇO", valor: "Serviços de espaço" },
];

describe("espelho da task no contato", () => {
  it("leva nome, produto e categoria; a lista casa sem ligar para caixa nem acento", () => {
    expect(atributosParaOContato(campos, definicoes, {})).toEqual({
      nome_completo: "Jimmy Carvalho Pires de Medeiros",
      tipo_de_produto_novo: "Sala de atendimento",
      categoria_de_servio: "Serviços de Espaço",
    });
  });

  it("⚠ só preenche o vazio: o que a equipe já escreveu no contato fica", () => {
    const atuais = { nome_completo: "Jimmy (VIP)", tipo_de_produto_novo: "Sala de reunião", id_clickup: "-" };
    expect(atributosParaOContato(campos, definicoes, atuais)).toEqual({
      categoria_de_servio: "Serviços de Espaço",
    });
    expect(atributosParaOContato(campos, definicoes, { nome_completo: "   " }).nome_completo).toBe(
      "Jimmy Carvalho Pires de Medeiros",
    );
  });

  it("⚠ opção que não está na lista não é gravada: apareceria em branco na tela", () => {
    const r = atributosParaOContato(
      [{ campo: "TIPO DE PRODUTO", valor: "Não definido" }, { campo: "CANAL", valor: "WhatsApp" }],
      definicoes,
      {},
    );
    expect(r).toEqual({});
  });

  it("opção com espaço sobrando na lista do Chatwoot sai limpa", () => {
    expect(
      atributosParaOContato([{ campo: "TIPO DE PRODUTO", valor: "sala privativa" }], definicoes, {}),
    ).toEqual({ tipo_de_produto_novo: "Sala Privativa" });
  });

  it("lista que o Chatwoot não devolveu (leitura falhou) não grava atributo de lista", () => {
    expect(atributosParaOContato(campos, [], {})).toEqual({
      nome_completo: "Jimmy Carvalho Pires de Medeiros",
    });
  });

  it("e-mail válido vai; texto que não é um e-mail não vai", () => {
    expect(atributosParaOContato([{ campo: "E-mail", valor: "Fulano@X.com" }], definicoes, {})).toEqual({
      email: "fulano@x.com",
    });
    expect(atributosParaOContato([{ campo: "E-mail", valor: "n/a" }], definicoes, {})).toEqual({});
  });

  it("⚠ CPF vai só com os dígitos e mantém o zero à esquerda; o que não é CPF não vai", () => {
    expect(atributosParaOContato([{ campo: "CPF", valor: "045.789.994-83" }], definicoes, {})).toEqual({
      cpf: "04578999483",
    });
    expect(atributosParaOContato([{ campo: "CPF", valor: "123" }], definicoes, {})).toEqual({});
  });

  it("valor que não é texto, ou em branco, é ignorado", () => {
    expect(
      atributosParaOContato(
        [{ campo: "NOME CLIENTE", valor: 5 }, { campo: "CPF", valor: "  " }],
        definicoes,
        {},
      ),
    ).toEqual({});
  });
});
