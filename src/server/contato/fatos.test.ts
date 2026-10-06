import { describe, expect, it } from "vitest";
import { camposComOsFatos, camposVaziosParaPreencher } from "./regras";

describe("fatos do cliente na task e no contato", () => {
  it("⚠ o que a task já traz vale mais que o cadastro; só entra o que falta", () => {
    const r = camposComOsFatos(
      [{ campo: "NOME CLIENTE", valor: "Maria" }],
      { nome: "MARIA DA SILVA LTDA", cpf: "04578999483", email: "m@x.com" },
    );
    expect(r).toEqual([
      { campo: "NOME CLIENTE", valor: "Maria" },
      { campo: "CPF", valor: "04578999483" },
      { campo: "E-mail", valor: "m@x.com" },
    ]);
  });

  it("campo da task em branco conta como ausente e é trocado pelo valor do cadastro", () => {
    expect(camposComOsFatos([{ campo: "CPF", valor: " " }], { cpf: "04578999483" })).toEqual([
      { campo: "CPF", valor: "04578999483" },
    ]);
  });

  it("⚠ só preenche campo que existe na lista e está vazio", () => {
    const lista = [{ name: "CPF" }, { name: "E-mail" }, { name: "Nome da sala" }];
    expect(
      camposVaziosParaPreencher(
        { cpf: "04578999483", email: "m@x.com", sala: "Sala 03", cnpj: "1" },
        lista,
        { "E-mail": "outro@x.com" },
      ),
    ).toEqual([
      { campo: "CPF", valor: "04578999483" },
      { campo: "Nome da sala", valor: "Sala 03" },
    ]);
  });
});
