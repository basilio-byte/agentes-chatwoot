import { describe, expect, it } from "vitest";
import type { AbaDoDoc, DocumentoGoogle, ElementoDoDoc } from "./client";
import { camposDoModelo, textoDoDocumento } from "./docs";

/**
 * O Google Docs não devolve texto: devolve uma árvore de `StructuralElement`.
 *
 * Quem lê só os parágrafos do topo perde a tabela — e perde **em silêncio**,
 * porque o que sobra continua sendo texto válido. O agente lê um procedimento
 * sem a tabela de etapas e responde com convicção sobre o que não leu. Por isso
 * os testes abaixo cobrem os ramos que somem sem dar erro: tabela e abas.
 */

const par = (...trechos: string[]): ElementoDoDoc => ({
  paragraph: { elements: trechos.map((content) => ({ textRun: { content } })) },
});

const tabela = (linhas: string[][]): ElementoDoDoc => ({
  table: {
    tableRows: linhas.map((celulas) => ({
      // Cada célula é outra árvore inteira, com parágrafos próprios — é essa
      // recursão que o leitor ingênuo não faz.
      tableCells: celulas.map((texto) => ({ content: [par(`${texto}\n`)] })),
    })),
  },
});

const aba = (texto: string, filhas: AbaDoDoc[] = []): AbaDoDoc => ({
  documentTab: { body: { content: [par(`${texto}\n`)] } },
  childTabs: filhas,
});

const doc = (parcial: DocumentoGoogle): DocumentoGoogle => parcial;

describe("textoDoDocumento", () => {
  it("junta os trechos de texto de cada parágrafo", () => {
    // A API quebra uma frase em vários `textRun` sempre que a formatação muda
    // no meio — negrito num nome já é suficiente. Juntar sem separador é o
    // certo: qualquer separador partiria a palavra.
    const documento = doc({
      body: {
        content: [
          par("Contrato de ", "prestação ", "de serviços\n"),
          par("Assinado em 2026.\n"),
        ],
      },
    });

    expect(textoDoDocumento(documento)).toBe(
      "Contrato de prestação de serviços\nAssinado em 2026.",
    );
  });

  it("⚠ extrai o conteúdo das TABELAS, separando célula por ` | `", () => {
    // Sem o separador, uma tabela de duas colunas vira frase emendada e o
    // modelo lê "Etapa Responsável" como um valor só. Sem o ramo da tabela, o
    // documento de procedimento volta com o título e nada do miolo.
    const documento = doc({
      body: {
        content: [
          par("Procedimento de entrada\n"),
          tabela([
            ["Etapa", "Responsável"],
            ["Conferir CPF", "Recepção"],
          ]),
        ],
      },
    });

    const texto = textoDoDocumento(documento);
    expect(texto).toContain("Etapa | Responsável");
    expect(texto).toContain("Conferir CPF | Recepção");
    expect(texto).toBe(
      "Procedimento de entrada\nEtapa | Responsável\nConferir CPF | Recepção",
    );
  });

  it("percorre as abas e as abas aninhadas", () => {
    const documento = doc({
      body: { content: [par("Introdução\n")] },
      tabs: [aba("Regras gerais", [aba("Exceções", [aba("Caso especial")])])],
    });

    const texto = textoDoDocumento(documento);
    expect(texto).toContain("Introdução");
    expect(texto).toContain("Regras gerais");
    expect(texto).toContain("Exceções");
    // Neto: `childTabs` é recursivo de verdade, não um nível só.
    expect(texto).toContain("Caso especial");
  });

  it("⚠ documento com body vazio mas com abas devolve o texto das abas", () => {
    // É o caso do documento ORGANIZADO por abas: `body` volta vazio e o
    // conteúdo inteiro está em `tabs`. Ler só `body` funciona na maioria dos
    // documentos e devolve string vazia justamente nos mais bem cuidados — o
    // agente diria "o documento está em branco" sobre um manual completo.
    const documento = doc({
      body: { content: [] },
      tabs: [aba("Política de cancelamento")],
    });

    expect(textoDoDocumento(documento)).toBe("Política de cancelamento");
  });

  it("não deixa passar quebra tripla", () => {
    // Parágrafo vazio é o jeito de dar espaço no Docs, e um documento com
    // espaçamento generoso vira um monte de "\n" que só gasta contexto — o
    // histórico é relido inteiro a cada turno.
    const documento = doc({
      body: {
        content: [par("Título\n"), par("\n"), par("\n"), par("\n"), par("Fim\n")],
      },
    });

    expect(textoDoDocumento(documento)).toBe("Título\n\nFim");
  });

  it("documento vazio devolve string vazia, sem estourar", () => {
    // Todos os campos são opcionais na resposta da API; um documento
    // recém-criado a partir de modelo em branco chega assim.
    expect(textoDoDocumento({})).toBe("");
    expect(textoDoDocumento({ body: { content: [] }, tabs: [] })).toBe("");
    expect(textoDoDocumento({ body: { content: [{}, { paragraph: {} }] } })).toBe(
      "",
    );
  });
});

describe("camposDoModelo", () => {
  const nomes = (texto: string) => camposDoModelo(texto).map((c) => c.nome);

  it("acha os campos `{{assim}}`, inclusive com espaço no nome", () => {
    expect(nomes("Prezado {{cliente}}, o valor é {{valor total}} por mês.")).toEqual(
      ["cliente", "valor total"],
    );
  });

  it("⚠ devolve o LITERAL junto do nome, e o literal preserva os espaços internos", () => {
    // Este é o teste que impede o documento órfão. A conferência do pedido do
    // agente é tolerante (casa "cliente" com "Cliente"), mas o
    // `replaceAllText` é literal e com `matchCase`. Um modelo escrito
    // `{{ Cliente }}` aprovava o pedido `cliente`, o `files.copy` criava o
    // documento, e a substituição achava ZERO ocorrências — sobrava no Drive um
    // contrato com `{{ Cliente }}` impresso, que nenhuma tool apaga, e mais um
    // a cada nova tentativa do agente.
    expect(camposDoModelo("Prezado {{ Cliente }},")).toEqual([
      { nome: "Cliente", literal: "{{ Cliente }}" },
    ]);
  });

  it("não repete o mesmo campo que aparece várias vezes", () => {
    // O modelo real repete o nome do cliente no cabeçalho, no corpo e na
    // assinatura. Listar três vezes faria o agente pedir o mesmo dado três
    // vezes ao cliente.
    expect(
      nomes("{{cliente}} — contrato de {{cliente}}, assinado por {{cliente}}."),
    ).toEqual(["cliente"]);
  });

  it("com duas grafias do mesmo campo, o primeiro literal vence", () => {
    // Substituir uma das grafias é melhor que não substituir nenhuma, e o campo
    // que sobrar aparece no texto para a revisão humana pegar.
    expect(camposDoModelo("{{cliente}} … {{ cliente }}")).toEqual([
      { nome: "cliente", literal: "{{cliente}}" },
    ]);
  });

  it("texto sem campo devolve lista vazia", () => {
    expect(camposDoModelo("Contrato padrão, sem nada a preencher.")).toEqual([]);
    expect(camposDoModelo("")).toEqual([]);
  });

  it("chave vazia é ignorada em vez de virar campo sem nome", () => {
    // `{{}}` sobra de quem apagou o nome do campo e esqueceu as chaves. Como
    // campo, ele viraria uma pergunta impossível de responder e travaria a
    // geração do documento por um resto de edição.
    expect(camposDoModelo("Assine aqui: {{}} e aqui: {{   }}")).toEqual([]);
    expect(nomes("{{}}{{nome}}")).toEqual(["nome"]);
  });
});
