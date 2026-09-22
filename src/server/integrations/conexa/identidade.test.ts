import { describe, expect, it } from "vitest";
import { RunSource } from "@/generated/prisma/enums";
import {
  documentoNasFalas,
  exigenciaDeIdentidade,
  numerosDoTexto,
  provarIdentidade,
} from "./identidade";

// Documentos de teste: o CPF é o mesmo número público usado nos outros testes
// do Conexa; o CNPJ é o da própria Receita (00.394.460/0058-87), público.
const CPF = "792.221.104-04";
const CNPJ = "00.394.460/0058-87";

describe("numerosDoTexto", () => {
  it("tira a pontuação de quem digita documento", () => {
    expect(numerosDoTexto(`meu cpf é ${CPF}`)).toEqual(["79222110404"]);
    expect(numerosDoTexto(`CNPJ ${CNPJ}`)).toEqual(["00394460005887"]);
    expect(numerosDoTexto("792 221 104 04")).toEqual(["79222110404"]);
  });

  it("vírgula, letra e quebra de linha separam números", () => {
    // ⚠ Juntar tudo faria desta frase uma fileira de onze dígitos.
    expect(numerosDoTexto("dia 24/09, 14h às 18h, 4 pessoas")).toEqual(["2409", "14", "18", "4"]);
    expect(numerosDoTexto("792221\n10404")).toEqual(["792221", "10404"]);
  });
});

describe("documentoNasFalas", () => {
  it("acha o documento digitado, com ou sem pontuação", () => {
    expect(documentoNasFalas(CPF, ["79222110404"])).toBe(true);
    expect(documentoNasFalas("79222110404", [`é ${CPF}`])).toBe(true);
    expect(documentoNasFalas(CNPJ, ["00394460005887"])).toBe(true);
  });

  it("acha o documento colado a outro número, separado só por espaço", () => {
    expect(documentoNasFalas(CPF, ["Maria 79222110404 84999990000"])).toBe(true);
  });

  it("aceita o CPF sem o zero da frente, que o cliente costuma omitir", () => {
    expect(documentoNasFalas("017.316.314-99", ["1731631499"])).toBe(true);
  });

  it("outro número não prova, nem o documento pela metade", () => {
    expect(documentoNasFalas(CPF, ["79222110405"])).toBe(false);
    expect(documentoNasFalas(CPF, ["792.221"])).toBe(false);
    expect(documentoNasFalas(CPF, ["Maria da Silva, cliente de vocês"])).toBe(false);
  });

  it("documento vazio ou curto nunca prova", () => {
    expect(documentoNasFalas("", ["79222110404"])).toBe(false);
    expect(documentoNasFalas("123", ["123"])).toBe(false);
  });
});

describe("provarIdentidade", () => {
  it("o documento do próprio cadastro prova", () => {
    expect(provarIdentidade({ doCliente: [CPF, undefined] }, [CPF])).toEqual({ comprovado: true });
    expect(provarIdentidade({ doCliente: [undefined, CNPJ] }, [CNPJ])).toEqual({ comprovado: true });
  });

  it("o CPF de uma pessoa vinculada prova, e diz qual pessoa é", () => {
    expect(
      provarIdentidade(
        { doCliente: [undefined, CNPJ], pessoas: [{ id: 7, cpf: "017.316.314-99" }, { id: 8, cpf: CPF }] },
        [`sou funcionária, meu cpf ${CPF}`],
      ),
    ).toEqual({ comprovado: true, pessoaId: 8 });
  });

  it("sem o número em nenhuma fala, não prova", () => {
    expect(
      provarIdentidade({ doCliente: [CPF], pessoas: [{ id: 8 }] }, ["Sou a Maria, já sou cliente"]),
    ).toEqual({ comprovado: false });
  });
});

describe("exigenciaDeIdentidade", () => {
  const historico = [
    { role: "user" as const, content: "meu cpf é 792.221.104-04" },
    { role: "assistant" as const, content: "o CPF cadastrado é 017.316.314-99" },
  ];

  it("no atendimento, valem as falas do cliente e a mensagem do turno — nunca as do robô", () => {
    const e = exigenciaDeIdentidade({ source: RunSource.CHATWOOT, historico, mensagem: "pode reservar" });
    expect(e).toEqual({
      tipo: "provar",
      falasDoCliente: ["meu cpf é 792.221.104-04", "pode reservar"],
    });
  });

  it("o playground trava igual ao atendimento", () => {
    expect(exigenciaDeIdentidade({ source: RunSource.PLAYGROUND, historico, mensagem: "x" }).tipo).toBe(
      "provar",
    );
  });

  it("na chamada interna, o PEDIDO de outro modelo não prova nada", () => {
    const e = exigenciaDeIdentidade({
      source: RunSource.INTERNO,
      historico,
      mensagem: "[Pedido interno de Salas — não é mensagem do cliente]\nCPF 017.316.314-99",
    });
    expect(e).toEqual({ tipo: "provar", falasDoCliente: ["meu cpf é 792.221.104-04"] });
  });

  it("mesa, gatilho e agendamento não têm cliente a provar", () => {
    for (const source of [RunSource.MESA, RunSource.TRIGGER, RunSource.SCHEDULE]) {
      expect(exigenciaDeIdentidade({ source }).tipo).toBe("livre");
    }
  });

  it("o sistema agindo sozinho não tem cliente a provar; sem origem nem marca, trava", () => {
    // O vigia reservando o presente de aniversário: a prova foi feita no pedido.
    expect(exigenciaDeIdentidade({ sistema: "aniversario" }).tipo).toBe("livre");
    expect(exigenciaDeIdentidade({}).tipo).toBe("provar");
  });

  it("turnos em segundo plano sobre uma conversa não agem em nome do cliente", () => {
    for (const source of [
      RunSource.CONVERSA_ENCERRADA,
      RunSource.CONVERSA_MARCADA,
      RunSource.CONVERSA_PARADA,
    ]) {
      expect(exigenciaDeIdentidade({ source }).tipo).toBe("semCliente");
    }
  });

  it("toda origem tem resposta — origem nova precisa ser decidida aqui", () => {
    for (const source of Object.values(RunSource)) {
      expect(exigenciaDeIdentidade({ source }).tipo).toBeDefined();
    }
  });

  it("sem origem, a trava fica fechada", () => {
    expect(exigenciaDeIdentidade({ historico, mensagem: "oi" }).tipo).toBe("provar");
  });
});
