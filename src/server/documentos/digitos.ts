/**
 * Dígito verificador de CPF, CNPJ e CNH.
 *
 * Puro e determinístico de propósito: **modelo de linguagem erra conta**. Pedir
 * ao agente que confira dígito verificador no prompt produz respostas confiantes
 * e erradas, e o erro cai para os dois lados — recusar documento bom e aceitar
 * número inventado.
 *
 * ⚠ O que isto prova e o que não prova. Um número com dígito válido é um número
 * **bem formado**; não diz que ele existe, que está ativo, nem que é da pessoa
 * que mandou a foto. Não existe consulta oficial gratuita para CPF nem para CNH
 * (a da Receita é página com captcha; a do Serpro é paga), então esta é a
 * camada mais forte disponível sem contrato. Ela pega erro de digitação e
 * número inventado, que é a esmagadora maioria do volume real — e não pega
 * falsificação.
 */

export type Veredito = {
  /** O número é bem formado (tamanho e dígito verificador conferem). */
  valido: boolean;
  /** Só dígitos, sem pontuação. Vazio quando não havia número. */
  numero: string;
  /** Por que foi recusado, em texto para o agente repassar. */
  motivo?: string;
};

function apenasDigitos(valor: string): string {
  return (valor ?? "").replace(/\D/g, "");
}

/** `11111111111` passa em qualquer soma ponderada — é o furo clássico. */
function todosIguais(numero: string): boolean {
  return /^(\d)\1*$/.test(numero);
}

/**
 * CPF: dois dígitos verificadores, pesos decrescentes a partir de 10 e de 11.
 *
 * Resto menor que 2 vira dígito 0 — é a regra que mais se erra ao reimplementar.
 */
export function validarCPF(entrada: string): Veredito {
  const numero = apenasDigitos(entrada);

  if (numero.length === 0) return { valido: false, numero, motivo: "sem número" };
  if (numero.length !== 11) {
    return {
      valido: false,
      numero,
      motivo: `CPF precisa ter 11 dígitos; este tem ${numero.length}`,
    };
  }
  if (todosIguais(numero)) {
    return { valido: false, numero, motivo: "sequência de dígitos repetidos" };
  }

  const digito = (ate: number, pesoInicial: number) => {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(numero[i]) * (pesoInicial - i);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const confere =
    digito(9, 10) === Number(numero[9]) && digito(10, 11) === Number(numero[10]);

  return confere
    ? { valido: true, numero }
    : { valido: false, numero, motivo: "dígito verificador não confere" };
}

/**
 * CNPJ: pesos cíclicos de 2 a 9, aplicados da direita para a esquerda.
 */
export function validarCNPJ(entrada: string): Veredito {
  const numero = apenasDigitos(entrada);

  if (numero.length === 0) return { valido: false, numero, motivo: "sem número" };
  if (numero.length !== 14) {
    return {
      valido: false,
      numero,
      motivo: `CNPJ precisa ter 14 dígitos; este tem ${numero.length}`,
    };
  }
  if (todosIguais(numero)) {
    return { valido: false, numero, motivo: "sequência de dígitos repetidos" };
  }

  const digito = (ate: number) => {
    let soma = 0;
    let peso = 2;
    for (let i = ate - 1; i >= 0; i--) {
      soma += Number(numero[i]) * peso;
      peso = peso === 9 ? 2 : peso + 1;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const confere =
    digito(12) === Number(numero[12]) && digito(13) === Number(numero[13]);

  return confere
    ? { valido: true, numero }
    : { valido: false, numero, motivo: "dígito verificador não confere" };
}

/**
 * CNH — número de registro, 11 dígitos.
 *
 * ⚠ **Este algoritmo tem variantes circulando**, e a diferença aparece no
 * segundo dígito quando o primeiro estoura (resto ≥ 10). Por isso o resultado
 * daqui é tratado como **indício**, nunca como recusa definitiva: quem consome
 * deve mandar conferir à mão em vez de declarar o documento inválido. Rejeitar
 * uma CNH boa é pior que aceitar uma suspeita para conferência humana.
 *
 * Também não confundir com o **número da CNH** impresso no corpo do documento
 * nem com o código de segurança — este valida o *registro*.
 */
export function validarRegistroCNH(entrada: string): Veredito {
  const numero = apenasDigitos(entrada);

  if (numero.length === 0) return { valido: false, numero, motivo: "sem número" };
  if (numero.length !== 11) {
    return {
      valido: false,
      numero,
      motivo: `registro de CNH tem 11 dígitos; este tem ${numero.length}`,
    };
  }
  if (todosIguais(numero)) {
    return { valido: false, numero, motivo: "sequência de dígitos repetidos" };
  }

  let soma = 0;
  for (let i = 0, peso = 9; i < 9; i++, peso--) soma += Number(numero[i]) * peso;

  let dv1 = soma % 11;
  // O desconto existe só quando o primeiro dígito estoura — e é exatamente
  // aqui que as implementações divergem entre si.
  let desconto = 0;
  if (dv1 >= 10) {
    dv1 = 0;
    desconto = 2;
  }

  soma = 0;
  for (let i = 0, peso = 1; i < 9; i++, peso++) soma += Number(numero[i]) * peso;

  let dv2 = soma % 11;
  dv2 = dv2 >= 10 ? 0 : dv2 - desconto;
  if (dv2 < 0) dv2 += 11;

  const confere = dv1 === Number(numero[9]) && dv2 === Number(numero[10]);

  return confere
    ? { valido: true, numero }
    : {
        valido: false,
        numero,
        motivo:
          "dígito verificador do registro não confere — confira o número à mão antes de recusar o documento",
      };
}

/** `12345678901` → `123.456.789-01`. Só para o texto que a pessoa vai ler. */
export function formatarCPF(numero: string): string {
  const d = apenasDigitos(numero);
  if (d.length !== 11) return numero;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export function formatarCNPJ(numero: string): string {
  const d = apenasDigitos(numero);
  if (d.length !== 14) return numero;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}
