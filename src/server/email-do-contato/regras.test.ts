import { describe, expect, it } from "vitest";
import {
  decidirGravacao,
  emailGravado,
  lerEmail,
  notaDoRegistro,
  type Resultado,
} from "./regras";

describe("lerEmail", () => {
  it("acha o e-mail sozinho na mensagem, em minúsculas", () => {
    expect(lerEmail("Fulano.Silva@Gmail.com")).toEqual({ tipo: "um", email: "fulano.silva@gmail.com" });
  });

  it("acha o e-mail dentro de uma frase, sem a pontuação que vem junto", () => {
    expect(lerEmail("meu email é fulano@empresa.com.br.")).toEqual({
      tipo: "um",
      email: "fulano@empresa.com.br",
    });
    expect(lerEmail("pode ser fulano+seahub@gmail.com, obrigado")).toEqual({
      tipo: "um",
      email: "fulano+seahub@gmail.com",
    });
  });

  it("o mesmo endereço repetido conta como um", () => {
    expect(lerEmail("a@x.com e de novo a@x.com")).toEqual({ tipo: "um", email: "a@x.com" });
  });

  it("⚠ dois endereços diferentes: não escolhe — poderia gravar o e-mail do contador", () => {
    expect(lerEmail("o meu é a@x.com e o do contador é b@y.com")).toEqual({ tipo: "varios" });
  });

  it("sem e-mail, ou com texto que só parece e-mail, não acha nada", () => {
    expect(lerEmail("Boa tarde")).toEqual({ tipo: "nenhum" });
    expect(lerEmail("fulano@gmail")).toEqual({ tipo: "nenhum" });
    expect(lerEmail("@fulano")).toEqual({ tipo: "nenhum" });
    expect(lerEmail("")).toEqual({ tipo: "nenhum" });
  });

  it("⚠ texto longo é documento colado, não alguém passando o e-mail", () => {
    expect(lerEmail(`${"contrato ".repeat(90)} a@x.com`)).toEqual({ tipo: "nenhum" });
  });

  it("e-mail da própria equipe é encaminhamento, não do cliente", () => {
    expect(lerEmail("fala com diego@seahubcoworking.com.br")).toEqual({ tipo: "nenhum" });
    expect(lerEmail("a@x.com e diego@seahubcoworking.com.br")).toEqual({ tipo: "um", email: "a@x.com" });
  });
});

describe("decidirGravacao", () => {
  it("vazio, em branco ou valor que não é texto: grava", () => {
    expect(decidirGravacao(undefined, "a@x.com")).toEqual({ acao: "gravar" });
    expect(decidirGravacao("  ", "a@x.com")).toEqual({ acao: "gravar" });
    expect(decidirGravacao(42, "a@x.com")).toEqual({ acao: "gravar" });
  });

  it("o mesmo e-mail, em outra caixa ou com espaço, é igual", () => {
    expect(decidirGravacao(" A@X.com ", "a@x.com")).toEqual({ acao: "igual" });
    expect(emailGravado(null)).toBeNull();
  });

  it("⚠ outro e-mail já gravado nunca é sobrescrito", () => {
    expect(decidirGravacao("velho@x.com", "novo@x.com")).toEqual({ acao: "outro", atual: "velho@x.com" });
  });
});

describe("notaDoRegistro", () => {
  const base: Resultado = { contato: { tipo: "gravado" }, tarefas: [] };

  it("diz o que foi gravado no contato e na task", () => {
    const nota = notaDoRegistro("a@x.com", {
      contato: { tipo: "gravado" },
      tarefas: [{ id: "86a", url: "https://app.clickup.com/t/86a", desfecho: { tipo: "gravado" } }],
    });
    expect(nota).toBe(
      [
        "📧 E-mail informado pelo cliente (registro automático): a@x.com",
        "✅ Contato no Chatwoot: gravado.",
        "✅ Task do CRM https://app.clickup.com/t/86a: gravado.",
      ].join("\n"),
    );
  });

  it("⚠ o e-mail que o cliente repete não gera nota nenhuma", () => {
    expect(
      notaDoRegistro("a@x.com", {
        contato: { tipo: "igual" },
        tarefas: [{ id: "86a", url: null, desfecho: { tipo: "igual" } }],
      }),
    ).toBeNull();
    expect(notaDoRegistro("a@x.com", { contato: { tipo: "igual" }, tarefas: [] })).toBeNull();
  });

  it("lista sem o campo não vira ruído, mas outro e-mail e falha aparecem", () => {
    const nota = notaDoRegistro("novo@x.com", {
      contato: { tipo: "outro", atual: "velho@x.com" },
      tarefas: [
        { id: "1", url: null, desfecho: { tipo: "sem campo" } },
        { id: "2", url: null, desfecho: { tipo: "falhou", motivo: "ClickUp respondeu 500" } },
      ],
    });
    expect(nota).toContain("⚠ Contato no Chatwoot: já tem outro e-mail (velho@x.com) — não foi trocado.");
    expect(nota).toContain("⚠ Task do CRM 2: não consegui gravar (ClickUp respondeu 500).");
    expect(nota).not.toContain("Task do CRM 1");
  });

  it("só o contato gravado já merece a nota", () => {
    expect(notaDoRegistro("a@x.com", base)).toContain("✅ Contato no Chatwoot: gravado.");
  });
});
