import type { AbaDoDoc, DocumentoGoogle, ElementoDoDoc } from "./client";

/**
 * Achatar a árvore do Google Docs em texto puro.
 *
 * A API não devolve texto: devolve uma árvore de `StructuralElement`, em que o
 * texto vive em `paragraph.elements[].textRun.content` e as tabelas escondem
 * outra árvore inteira dentro de cada célula. Quem lê só os parágrafos do topo
 * perde exatamente o que costuma importar num documento de procedimento — a
 * tabela — e perde em silêncio, porque o texto que sobra é válido.
 *
 * Puro e testado por isso.
 */

function textoDoElemento(elemento: ElementoDoDoc): string {
  if (elemento.paragraph) {
    return (elemento.paragraph.elements ?? [])
      .map((e) => e.textRun?.content ?? "")
      .join("");
  }

  if (elemento.table) {
    return (elemento.table.tableRows ?? [])
      .map((linha) =>
        (linha.tableCells ?? [])
          .map((celula) => textoDoConteudo(celula.content ?? []).trim())
          // Separador de célula: sem ele, uma tabela de duas colunas vira uma
          // frase emendada e o modelo lê "Nome João" como um valor só.
          .join(" | "),
      )
      .join("\n");
  }

  if (elemento.tableOfContents) {
    return textoDoConteudo(elemento.tableOfContents.content ?? []);
  }

  return "";
}

function textoDoConteudo(conteudo: ElementoDoDoc[]): string {
  return conteudo.map(textoDoElemento).join("");
}

/**
 * Percorre as abas, incluindo as aninhadas.
 *
 * ⚠ Abas de documento são recursivas (`childTabs`), e um documento organizado
 * por abas devolve o corpo VAZIO em `body` — o conteúdo está todo em `tabs`.
 * Ler só `body` funciona para a maioria dos documentos e devolve string vazia
 * justamente nos mais organizados.
 */
function textoDasAbas(abas: AbaDoDoc[]): string {
  return abas
    .map((aba) => {
      const proprio = textoDoConteudo(aba.documentTab?.body?.content ?? []);
      const filhas = textoDasAbas(aba.childTabs ?? []);
      return [proprio, filhas].filter((t) => t.trim()).join("\n");
    })
    .filter((t) => t.trim())
    .join("\n");
}

export function textoDoDocumento(documento: DocumentoGoogle): string {
  const corpo = textoDoConteudo(documento.body?.content ?? []);
  const abas = textoDasAbas(documento.tabs ?? []);

  return [corpo, abas]
    .filter((t) => t.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Um campo `{{assim}}` do modelo: o nome legível e o texto exato no documento. */
export type CampoDoModelo = {
  /** Sem as chaves e sem espaço nas pontas. É o que o agente informa. */
  nome: string;
  /** O trecho literal, com chaves e espaços. É o que a substituição procura. */
  literal: string;
};

/**
 * Os campos `{{assim}}` que existem no modelo.
 *
 * Serve para conferir ANTES de copiar o arquivo. A ordem importa: `files.copy`
 * cria o documento de verdade, e se a checagem viesse depois já haveria um
 * arquivo órfão no Drive — que ninguém pode apagar, porque não existe tool de
 * exclusão de propósito.
 *
 * ⚠ **Devolve os DOIS: o nome e o literal.** Conferir por um e substituir pelo
 * outro é o defeito que a ordem da checagem existia para impedir e não impedia.
 * O `replaceAllText` é literal e com `matchCase`, então um modelo escrito
 * `{{ Cliente }}` só casa com essa string exata; conferir o pedido do agente
 * (`cliente`) contra o nome trimado aprovava, o `files.copy` criava o
 * documento, e a substituição achava zero ocorrências. Sobrava no Drive um
 * contrato com `{{ Cliente }}` impresso — e mais um a cada nova tentativa.
 */
export function camposDoModelo(texto: string): CampoDoModelo[] {
  const achados = texto.match(/\{\{[^{}]+\}\}/g) ?? [];
  const porNome = new Map<string, string>();

  for (const bruto of achados) {
    const nome = bruto.slice(2, -2).trim();
    // O primeiro literal vence: um modelo que escreva `{{Cliente}}` e
    // `{{ Cliente }}` tem duas grafias do mesmo campo, e substituir só uma é
    // melhor que não substituir nenhuma. O aviso de ocorrências zero não
    // dispara nesse caso, mas o campo remanescente aparece no texto.
    if (nome && !porNome.has(nome)) porNome.set(nome, bruto);
  }

  return [...porNome].map(([nome, literal]) => ({ nome, literal }));
}
