import { describe, expect, it } from "vitest";
import { camposDoContatoQueFaltam } from "./regras";

/** O caminho de volta: o que a equipe preencheu no contato do Chatwoot vai para a task. */
describe("camposDoContatoQueFaltam", () => {
  const lista = [
    { name: "CANAL" },
    { name: "Qualificação" },
    { name: "RESPONSÁVEL" },
    { name: "CPF" },
    { name: "TIPO DE PRODUTO" },
    { name: "VALOR CONTRATO" },
  ];

  it("leva canal, qualificação e responsável para os campos vazios", () => {
    expect(
      camposDoContatoQueFaltam({ canal: "Redes sociais", qualificao: "5", responsvel: "Maria" }, lista, {}),
    ).toEqual([
      { campo: "CANAL", valor: "Redes sociais" },
      { campo: "Qualificação", valor: "5" },
      { campo: "RESPONSÁVEL", valor: "Maria" },
    ]);
  });

  it("nunca sobrescreve o que a task já tem (nome do campo sem acento nem caixa)", () => {
    expect(camposDoContatoQueFaltam({ canal: "Site", responsvel: "Maria" }, lista, { canal: 2, "Responsavel": "" })).toEqual([
      { campo: "RESPONSÁVEL", valor: "Maria" },
    ]);
  });

  it("não leva o que é do NEGÓCIO (produto, valor) nem o que a lista não tem", () => {
    expect(
      camposDoContatoQueFaltam(
        { tipo_de_produto_novo: "Sala Privativa", valor_contrato: 500, contador: "João" },
        lista,
        {},
      ),
    ).toEqual([]);
  });

  it("documento só com os dígitos todos: número sem o zero à esquerda fica de fora", () => {
    expect(camposDoContatoQueFaltam({ cpf: 1234567890 }, lista, {})).toEqual([]);
    expect(camposDoContatoQueFaltam({ cpf: "012.345.678-90" }, lista, {})).toEqual([
      { campo: "CPF", valor: "01234567890" },
    ]);
  });
});
