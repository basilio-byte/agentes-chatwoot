import { MediaKind } from "@/generated/prisma/enums";

/**
 * Como um anexo lido vira texto na mensagem que o modelo recebe.
 *
 * Puro e testado porque é a interface entre o que o cliente mandou e o que o
 * agente acredita que o cliente disse. Um áudio transcrito sem marcação seria
 * lido como se a pessoa tivesse digitado aquilo — e o agente responderia
 * "conforme você escreveu" sobre uma coisa que foi falada.
 */

/**
 * Teto do texto derivado de UM anexo.
 *
 * Um PDF de cinquenta páginas resumido sem limite entope o contexto de todos os
 * turnos seguintes (o histórico é relido inteiro a cada mensagem). Cortar em
 * silêncio seria pior: o corte aparece, como em `TETO_DE_TEXTO` das execuções.
 */
export const TETO_DE_TEXTO_POR_ANEXO = 6_000;

const ROTULO: Record<MediaKind, string> = {
  [MediaKind.AUDIO]: "áudio transcrito",
  [MediaKind.IMAGE]: "imagem",
  [MediaKind.DOCUMENT]: "documento",
  [MediaKind.UNSUPPORTED]: "anexo não lido",
};

export function rotuloDoTipo(kind: MediaKind): string {
  return ROTULO[kind];
}

export function cortar(texto: string, teto = TETO_DE_TEXTO_POR_ANEXO): string {
  const limpo = texto.trim();
  if (limpo.length <= teto) return limpo;
  return `${limpo.slice(0, teto)}\n[…texto cortado: o anexo tem mais do que cabe no contexto]`;
}

export type AnexoLido = {
  kind: MediaKind;
  nome?: string | null;
  texto?: string | null;
  /** Quando a leitura não deu certo. Entra no lugar do texto. */
  falha?: string | null;
};

/**
 * A linha que representa um anexo dentro da mensagem.
 *
 * O colchete na frente é o que separa "o cliente escreveu" de "o sistema leu
 * para você" — sem ele o modelo trata transcrição como digitação.
 */
export function linhaDoAnexo(lido: AnexoLido): string {
  const nome = (lido.nome ?? "").trim();
  const cabecalho = nome
    ? `[${rotuloDoTipo(lido.kind)} — ${nome}]`
    : `[${rotuloDoTipo(lido.kind)}]`;

  const conteudo = (lido.texto ?? "").trim();
  if (conteudo) return `${cabecalho} ${cortar(conteudo)}`;

  const falha = (lido.falha ?? "").trim();
  return falha
    ? `${cabecalho} ${falha}`
    : `${cabecalho} não foi possível ler este anexo.`;
}

/**
 * Junta o que o cliente escreveu com o que foi lido dos anexos.
 *
 * O texto digitado vem primeiro: ele é o que a pessoa quis dizer; o anexo é
 * apoio. Quando não há texto nenhum, a mensagem passa a ser só os anexos — que
 * é o caso do áudio de WhatsApp, o mais comum de todos.
 */
export function juntarComAnexos(
  conteudo: string | null | undefined,
  anexos: AnexoLido[],
): string {
  const texto = (conteudo ?? "").trim();
  const linhas = anexos.map(linhaDoAnexo);

  if (linhas.length === 0) return texto;
  return [texto, ...linhas].filter(Boolean).join("\n");
}

/**
 * Aviso que entra na mensagem quando a leitura de mídia está desligada.
 *
 * Sem isto, um agente com a capacidade desligada recebia a mensagem vazia e
 * respondia "não entendi" — sem nunca dizer que chegou um áudio. Silêncio
 * precisa deixar rastro, inclusive para o modelo.
 */
export function avisoDeLeituraDesligada(quantidade: number): string {
  return quantidade === 1
    ? "[anexo recebido] o cliente enviou um anexo, mas a leitura de mídia está desligada — peça que ele escreva o conteúdo."
    : `[anexos recebidos] o cliente enviou ${quantidade} anexos, mas a leitura de mídia está desligada — peça que ele escreva o conteúdo.`;
}
