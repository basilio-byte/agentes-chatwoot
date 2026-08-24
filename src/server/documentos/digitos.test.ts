import { describe, expect, it } from "vitest";
import {
  formatarCNPJ,
  formatarCPF,
  validarCNPJ,
  validarCPF,
  validarRegistroCNH,
} from "./digitos";

/**
 * Estes testes existem porque o erro aqui é caro nos dois sentidos: recusar o
 * documento bom de um cliente é atrito na recepção, e aceitar número inventado
 * é o contrário do que a conferência promete.
 *
 * Os CPFs e CNPJs abaixo são números **reais e válidos** de uso público em
 * teste — não gerados por este mesmo algoritmo, senão a verificação seria
 * circular e passaria mesmo com a conta errada.
 */

describe("CPF", () => {
  it("aceita números sabidamente válidos", () => {
    for (const cpf of ["529.982.247-25", "111.444.777-35", "12345678909"]) {
      expect(validarCPF(cpf).valido, cpf).toBe(true);
    }
  });

  it("recusa dígito verificador trocado", () => {
    const r = validarCPF("529.982.247-26");
    expect(r.valido).toBe(false);
    expect(r.motivo).toContain("dígito verificador");
  });

  it("recusa a sequência repetida, que passa na soma ponderada", () => {
    // `11111111111` fecha a conta e é o furo clássico de quem reimplementa.
    for (const cpf of ["111.111.111-11", "00000000000", "99999999999"]) {
      expect(validarCPF(cpf).valido, cpf).toBe(false);
    }
  });

  it("diz o tamanho errado em vez de só recusar", () => {
    const r = validarCPF("1234567890");
    expect(r.valido).toBe(false);
    expect(r.motivo).toContain("10");
  });

  it("ignora pontuação e devolve só os dígitos", () => {
    expect(validarCPF("529.982.247-25").numero).toBe("52998224725");
  });

  it("entrada vazia não estoura", () => {
    expect(validarCPF("").valido).toBe(false);
    expect(validarCPF("   ").motivo).toBe("sem número");
    expect(validarCPF("abc").motivo).toBe("sem número");
  });
});

describe("CNPJ", () => {
  it("aceita números reais válidos", () => {
    // O segundo é o dos Correios — número público e verificável.
    for (const cnpj of ["11.222.333/0001-81", "34.028.316/0001-03"]) {
      expect(validarCNPJ(cnpj).valido, cnpj).toBe(true);
    }
  });

  it("recusa dígito trocado e sequência repetida", () => {
    expect(validarCNPJ("11.222.333/0001-82").valido).toBe(false);
    expect(validarCNPJ("00.000.000/0000-00").valido).toBe(false);
  });

  it("cobra os 14 dígitos", () => {
    expect(validarCNPJ("11222333000").motivo).toContain("14 dígitos");
  });
});

describe("registro de CNH", () => {
  /**
   * ⚠ Não há aqui um número real de referência, e isso é uma limitação
   * conhecida: o algoritmo tem variantes circulando e a divergência aparece
   * quando o primeiro dígito estoura. Por isso o módulo trata o resultado como
   * indício e a mensagem manda conferir à mão — recusar uma CNH boa é pior que
   * mandar conferir uma suspeita.
   */
  it("recusa tamanho errado", () => {
    expect(validarRegistroCNH("123456789").valido).toBe(false);
    expect(validarRegistroCNH("123456789012").motivo).toContain("11 dígitos");
  });

  it("recusa sequência repetida", () => {
    expect(validarRegistroCNH("11111111111").valido).toBe(false);
  });

  it("a mensagem manda conferir à mão, não declara o documento falso", () => {
    // A diferença importa: o agente repassa este texto para uma pessoa.
    const r = validarRegistroCNH("12345678900");
    if (r.valido) return;
    expect(r.motivo).toContain("à mão");
    expect(r.motivo).not.toContain("falso");
  });

  it("é seletivo — não carimba qualquer número como válido", () => {
    // Dois dígitos verificadores devem deixar passar perto de 1 em 121. Se
    // alguém quebrar a conta e ela virar permissiva, isto pega.
    let aceitos = 0;
    const total = 12_100;
    for (let i = 0; i < total; i++) {
      const n = String(i * 7919).padStart(11, "0").slice(-11);
      if (validarRegistroCNH(n).valido) aceitos++;
    }
    expect(aceitos).toBeGreaterThan(0);
    expect(aceitos).toBeLessThan(total / 40);
  });
});

describe("formatação para humano", () => {
  it("põe a pontuação de volta", () => {
    expect(formatarCPF("52998224725")).toBe("529.982.247-25");
    expect(formatarCNPJ("11222333000181")).toBe("11.222.333/0001-81");
  });

  it("devolve como veio quando o tamanho não bate", () => {
    expect(formatarCPF("123")).toBe("123");
    expect(formatarCNPJ("123")).toBe("123");
  });
});
