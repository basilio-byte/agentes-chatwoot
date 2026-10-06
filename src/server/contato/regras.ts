import { lerEmail } from "@/server/email-do-contato/regras";

/**
 * A task do CRM é espelhada no cadastro do CONTATO do Chatwoot — as regras puras.
 *
 * Nasceu do mesmo chamado do Diego (06/10/2026): a task saiu com tipo de
 * produto e categoria, mas o contato no Chatwoot ficou só com `url` e
 * `id_clickup`. Quem atende olha o painel do contato, e o que o robô já
 * descobriu (produto, categoria, nome, CPF, e-mail) tem de estar lá.
 *
 * ⚠ **Só PREENCHE o que está vazio.** O contato é um cadastro vivo que a equipe
 * edita; o que já está lá é de quem preencheu.
 * ⚠ **Atributo de lista só entra se a opção existir** (comparando sem acento nem
 * caixa): um valor fora da lista aparece em branco na tela do Chatwoot, o que é
 * pior que não gravar.
 */

/** As listas do CRM. O espelho só vale para task criada nelas. */
export const LISTAS_DO_CRM = ["901302419821", "901306195904"];

type Regra = {
  /** O campo da task, como o agente o nomeia ao criar. */
  campo: string;
  /** A chave do atributo no contato. */
  chave: string;
  tipo: "texto" | "lista" | "email" | "cpf";
};

export const REGRAS_DO_ESPELHO: Regra[] = [
  { campo: "NOME CLIENTE", chave: "nome_completo", tipo: "texto" },
  { campo: "TIPO DE PRODUTO", chave: "tipo_de_produto_novo", tipo: "lista" },
  { campo: "CATEGORIA DE SERVIÇO", chave: "categoria_de_servio", tipo: "lista" },
  { campo: "CANAL", chave: "canal", tipo: "lista" },
  { campo: "E-mail", chave: "email", tipo: "email" },
  { campo: "CPF", chave: "cpf", tipo: "cpf" },
];

export type DefinicaoDeAtributo = { chave: string; tipo: string; opcoes: string[] };

const normalizar = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const vazio = (v: unknown) => v === undefined || v === null || (typeof v === "string" && !v.trim());

/**
 * O que gravar no contato: um mapa chave → valor, só com o que o campo da task
 * traz, o contato ainda não tem e é válido para o atributo.
 */
export function atributosParaOContato(
  campos: { campo: string; valor: unknown }[],
  definicoes: DefinicaoDeAtributo[],
  atuais: Record<string, unknown>,
): Record<string, string> {
  const saida: Record<string, string> = {};

  for (const regra of REGRAS_DO_ESPELHO) {
    const achado = campos.find((c) => normalizar(c.campo) === normalizar(regra.campo));
    if (!achado || typeof achado.valor !== "string" || !achado.valor.trim()) continue;
    if (!vazio(atuais[regra.chave])) continue;

    const texto = achado.valor.trim();
    switch (regra.tipo) {
      case "texto":
        saida[regra.chave] = texto.slice(0, 200);
        break;
      case "email": {
        const lido = lerEmail(texto);
        if (lido.tipo === "um") saida[regra.chave] = lido.email;
        break;
      }
      case "cpf": {
        // Só os dígitos, e só se for um CPF: o `0` à esquerda é do documento.
        const digitos = texto.replace(/\D/g, "");
        if (digitos.length === 11) saida[regra.chave] = digitos;
        break;
      }
      case "lista": {
        const opcoes = definicoes.find((d) => d.chave === regra.chave)?.opcoes ?? [];
        const opcao = opcoes.find((o) => normalizar(o) === normalizar(texto));
        if (opcao) saida[regra.chave] = opcao.trim();
        break;
      }
    }
  }
  return saida;
}

/**
 * O que se sabe do cliente por OUTRAS fontes que não a task: o cadastro do Conexa
 * e a reserva que o agente acabou de fazer.
 */
export type FatosDoCliente = {
  nome?: string;
  cpf?: string;
  cnpj?: string;
  email?: string;
  celular?: string;
  sala?: string;
};

/** Campo da task → fato. O nome é comparado sem acento nem caixa. */
const CAMPOS_DA_TASK: { campo: string; fato: keyof FatosDoCliente }[] = [
  { campo: "NOME CLIENTE", fato: "nome" },
  { campo: "CPF", fato: "cpf" },
  { campo: "CNPJ", fato: "cnpj" },
  { campo: "E-mail", fato: "email" },
  { campo: "Nome da sala", fato: "sala" },
];

/**
 * Os fatos que a task ainda NÃO traz, no formato de `campos` do espelho: assim o
 * contato recebe o que a task não tem, e o que a task já diz vale mais do que o
 * cadastro (foi o que o agente acabou de confirmar com o cliente).
 */
export function camposComOsFatos(
  campos: { campo: string; valor: unknown }[],
  fatos: FatosDoCliente,
): { campo: string; valor: unknown }[] {
  let saida = [...campos];
  for (const { campo, fato } of CAMPOS_DA_TASK) {
    const valor = fatos[fato];
    if (!valor) continue;
    const mesmo = (c: { campo: string }) => normalizar(c.campo) === normalizar(campo);
    if (saida.some((c) => mesmo(c) && !vazio(c.valor))) continue;
    // Em branco na task não pode ficar na frente do valor do cadastro.
    saida = saida.filter((c) => !mesmo(c));
    saida.push({ campo, valor });
  }
  return saida;
}

/**
 * Campos da task que estão VAZIOS e que os fatos preenchem. Só campo que existe
 * na lista, só o que está em branco, nunca sobrescreve o que a equipe escreveu.
 */
export function camposVaziosParaPreencher(
  fatos: FatosDoCliente,
  camposDaLista: { name?: string }[],
  valoresAtuais: Record<string, unknown>,
): { campo: string; valor: string }[] {
  const saida: { campo: string; valor: string }[] = [];
  for (const { campo, fato } of CAMPOS_DA_TASK) {
    const valor = fatos[fato];
    if (!valor) continue;
    const existente = camposDaLista.find((c) => normalizar(c.name ?? "") === normalizar(campo));
    if (!existente?.name) continue;
    if (!vazio(valoresAtuais[existente.name])) continue;
    saida.push({ campo: existente.name, valor });
  }
  return saida;
}
