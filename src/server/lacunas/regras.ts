import { TipoDeLacuna } from "@/generated/prisma/enums";

/**
 * Regras puras do relatório de lacunas dos agentes (task "Mapeamento de
 * passagem dos agentes", 27/10/2026).
 *
 * A pergunta que o relatório responde é *"o que faltou para o agente resolver
 * sozinho?"* — e só vale para a passagem por INCAPACIDADE. O agente é quem diz
 * qual foi a causa, em `transferir_para_humano`, porque só ele sabe por que
 * está desistindo. As quatro causas abaixo são o que ele pode declarar; três
 * viram lacuna, uma não.
 */

/** Valores do parâmetro `causa` da ferramenta, na ordem em que o modelo os lê. */
export const CAUSAS = [
  "pedido_do_cliente",
  "falta_de_instrucao",
  "falta_de_ferramenta",
  "nao_entendi",
] as const;

export type Causa = (typeof CAUSAS)[number];

/**
 * Do que o agente declarou para o que o relatório guarda.
 *
 * `null` é a causa que NÃO é lacuna: o cliente pediu uma pessoa, ou a regra do
 * negócio manda passar (cobrança, cancelamento, reclamação). Nesses casos o
 * agente fez exatamente o que devia, e registrá-lo no relatório encheria a
 * lista de ruído justamente onde a equipe procura o que consertar.
 */
export function tipoDaCausa(causa: Causa): TipoDeLacuna | null {
  switch (causa) {
    case "falta_de_instrucao":
      return TipoDeLacuna.FALTA_INSTRUCAO;
    case "falta_de_ferramenta":
      return TipoDeLacuna.FALTA_FERRAMENTA;
    case "nao_entendi":
      return TipoDeLacuna.NAO_ENTENDI;
    case "pedido_do_cliente":
      return null;
  }
}

/**
 * Rótulo curto de cada tipo, para a tela, o filtro e o MCP.
 *
 * `Record<TipoDeLacuna, …>`: tipo novo sem rótulo quebra o typecheck aqui, e
 * não aparece cru num canto da interface.
 */
export const ROTULO_DO_TIPO: Record<TipoDeLacuna, string> = {
  [TipoDeLacuna.FALTA_INSTRUCAO]: "Faltou instrução",
  [TipoDeLacuna.FALTA_FERRAMENTA]: "Faltou ferramenta",
  [TipoDeLacuna.NAO_ENTENDI]: "Não entendeu o pedido",
};

/** O que fornecer para fechar cada tipo de lacuna — é o que a equipe faz com ela. */
export const O_QUE_FORNECER: Record<TipoDeLacuna, string> = {
  [TipoDeLacuna.FALTA_INSTRUCAO]:
    "Acrescentar ao prompt do agente a resposta ou o procedimento.",
  [TipoDeLacuna.FALTA_FERRAMENTA]:
    "Ligar uma ferramenta que o agente não tem, ou criar a que falta.",
  [TipoDeLacuna.NAO_ENTENDI]:
    "Conferir a conversa: o pedido estava claro? O prompt precisa de um exemplo desse caso?",
};

/** Teto de cada texto livre guardado. O agente escreve uma frase, não um relato. */
export const TETO_DO_TEXTO = 600;

/**
 * Limpa o que o agente escreveu antes de guardar: espaços colapsados, nada de
 * quebra de linha e corte com reticências.
 *
 * ⚠ O corte existe porque o campo vem de um modelo que leu a mensagem do
 * cliente — um despejo da conversa inteira entraria no relatório e na lista
 * que a equipe toda lê. Cortar avisa (`…`); guardar tudo seria o relatório
 * virar um segundo histórico de conversa.
 */
export function limparTexto(texto: string, teto = TETO_DO_TEXTO): string {
  const limpo = texto.replace(/\s+/g, " ").trim();
  if (limpo.length <= teto) return limpo;
  return `${limpo.slice(0, teto - 1).trimEnd()}…`;
}

const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g;
/** Dígitos com os separadores de telefone, CPF e CNPJ no meio. */
const SEQUENCIA_DE_DIGITOS = /\(?\d[\d.\-()/ ]{6,}\d/g;
/** Abaixo disso é data ou quantidade ("27/10/2026", "20 pessoas"), não documento. */
const DIGITOS_DE_DOCUMENTO = 9;

/**
 * Tira e-mail e número longo (telefone, CPF, CNPJ) do que o agente escreveu.
 *
 * O prompt do parâmetro já manda não pôr dado pessoal, mas o campo vem de um
 * modelo que leu a conversa do cliente — e o relatório é aberto por toda a
 * equipe, inclusive quem só lê, e sai pelo MCP. Instrução o modelo pula; isto é
 * o que garante. Cobre o que tem formato (e-mail, telefone, documento); nome de
 * pessoa não tem formato, e quem barra é o parâmetro.
 */
export function ocultarDadosPessoais(texto: string): string {
  return texto.replace(EMAIL, "[e-mail]").replace(SEQUENCIA_DE_DIGITOS, (trecho) =>
    trecho.replace(/\D/g, "").length >= DIGITOS_DE_DOCUMENTO ? "[número]" : trecho,
  );
}

/**
 * Texto de `oQueFaltou` que não diz nada: o relatório existe para a equipe
 * saber o que fornecer, e "falta informação" não diz.
 *
 * Mínimo de dez caracteres úteis — barra o "n/a", o "-" e o "sim", e deixa
 * passar qualquer frase de verdade. Não tenta julgar a qualidade: mais que
 * isso seria o sistema decidindo o que o modelo pode dizer.
 */
export function detalheVazio(texto: string | undefined): boolean {
  return limparTexto(texto ?? "").length < 10;
}
