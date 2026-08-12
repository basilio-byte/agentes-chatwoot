import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Field, Input, Select } from "./ui";

/**
 * O bug que originou este arquivo: a mensagem de validação era passada como
 * `hint` e saía no mesmo cinza do texto de ajuda, enquanto o formulário
 * anunciava "confira os campos destacados" sem destacar nada. Quem errava a
 * senha lia "Use pelo menos 10 caracteres" achando que era instrução.
 */

const html = (no: React.ReactElement) => renderToStaticMarkup(no);

describe("Field", () => {
  it("mostra a dica em cinza quando não há erro", () => {
    const saida = html(
      <Field label="Senha" hint="Mínimo de 10 caracteres.">
        <Input name="password" />
      </Field>,
    );

    expect(saida).toContain("Mínimo de 10 caracteres.");
    expect(saida).toContain("text-muted");
    expect(saida).not.toContain("text-danger");
  });

  it("pinta a mensagem de erro de vermelho", () => {
    const saida = html(
      <Field label="Senha" erro="Use pelo menos 10 caracteres">
        <Input name="password" />
      </Field>,
    );

    expect(saida).toContain("Use pelo menos 10 caracteres");
    expect(saida).toContain("text-danger");
  });

  it("destaca a borda do controle, que é o que o aviso promete", () => {
    // "Confira os campos destacados" só faz sentido se algum campo destacar.
    const saida = html(
      <Field label="Senha" erro="curta demais">
        <Input name="password" />
      </Field>,
    );

    expect(saida).toContain("border-danger");
  });

  it("destaca também select e textarea, e não só input", () => {
    // Sem o `&` no casamento: no HTML ele sai escapado como `&amp;`.
    const saida = html(
      <Field label="Papel" erro="inválido">
        <Select name="role" />
      </Field>,
    );

    expect(saida).toContain("_select]:border-danger");
    expect(saida).toContain("_textarea]:border-danger");
  });

  it("erro vence a dica — nunca aparecem os dois", () => {
    const saida = html(
      <Field
        label="Senha"
        hint="Mínimo de 10 caracteres."
        erro="Use pelo menos 10 caracteres"
      >
        <Input name="password" />
      </Field>,
    );

    expect(saida).toContain("Use pelo menos 10 caracteres");
    expect(saida).not.toContain("Mínimo de 10 caracteres.");
  });

  it("anuncia o erro para leitor de tela", () => {
    // A mensagem aparece depois do envio; sem role=alert ela passa em silêncio
    // para quem navega por leitor de tela.
    const saida = html(
      <Field label="Senha" erro="curta demais">
        <Input name="password" />
      </Field>,
    );

    expect(saida).toContain('role="alert"');
  });

  it("sem dica e sem erro, não sobra linha vazia embaixo do campo", () => {
    const saida = html(
      <Field label="Nome">
        <Input name="name" />
      </Field>,
    );

    // `block text-xs` é a assinatura da linha de baixo — tanto da dica quanto
    // do erro. Procurar só por "text-muted" daria falso positivo: o próprio
    // Input carrega `placeholder:text-muted/70`.
    expect(saida).not.toContain("block text-xs");
    expect(saida).not.toContain("border-danger");
  });
});
