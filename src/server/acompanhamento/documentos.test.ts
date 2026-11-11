import { describe, expect, it } from "vitest";

import {
  blocoDaDocumentacao,
  documentosDoProduto,
  lerDocumentos,
  urlValida,
} from "./documentos";

/** O texto real da automação do ClickBot, como a equipe o mantém (11/11/2026). */
const LITORAL = `
[Endereço Fiscal Litoral]
AVCB: https://drive.google.com/file/d/18TyQrosLkX07xpWewvwd4lBqtwtnWcuy/view?usp=sharing
Habite-se: https://drive.google.com/file/d/1scL6qe9ZFPf40UME3LT3IY6EoF6f00lG/view?usp=drive_link
Ficha do Imóvel: https://drive.google.com/file/d/1rg8xCe0h9ONuwSsW_ODbm0fkH2T2qRwW/view?usp=drive_link
`;

describe("lerDocumentos", () => {
  it("lê a seção do produto e cada documento", () => {
    const r = lerDocumentos(LITORAL);
    expect(Object.keys(r)).toEqual(["Endereço Fiscal Litoral"]);
    expect(r["Endereço Fiscal Litoral"]).toHaveLength(3);
    expect(r["Endereço Fiscal Litoral"][0]).toEqual({
      nome: "AVCB",
      url: "https://drive.google.com/file/d/18TyQrosLkX07xpWewvwd4lBqtwtnWcuy/view?usp=sharing",
    });
  });

  /**
   * ⚠ O endereço TEM dois-pontos dentro (`https:`). Partir pelo último, ou
   * por todos, devolveria um link quebrado — e link quebrado num WhatsApp de
   * cliente é pior que link nenhum.
   */
  it("parte no PRIMEIRO dois-pontos, não no de dentro da URL", () => {
    const r = lerDocumentos("[P]\nFicha do Imóvel: https://x.test/a?b=c:d");
    expect(r.P[0]).toEqual({ nome: "Ficha do Imóvel", url: "https://x.test/a?b=c:d" });
  });

  it("separa produtos, e seção vazia não vira documento de outro", () => {
    const r = lerDocumentos("[A]\nAVCB: https://a.test/1\n\n[B]\n");
    expect(r.A).toHaveLength(1);
    expect(r.B).toEqual([]);
  });

  it("linha antes de qualquer seção é ignorada: não sei de que prédio é", () => {
    expect(lerDocumentos("AVCB: https://a.test/1")).toEqual({});
  });

  it("linha sem URL válida é descartada, e não derruba as outras", () => {
    const r = lerDocumentos("[A]\nAVCB: falta o link\nART: https://a.test/2\nsó texto");
    expect(r.A).toEqual([{ nome: "ART", url: "https://a.test/2" }]);
  });

  it("texto vazio ou nulo não quebra", () => {
    expect(lerDocumentos("")).toEqual({});
    expect(lerDocumentos(null)).toEqual({});
  });
});

describe("urlValida", () => {
  it("aceita só http e https", () => {
    expect(urlValida("https://drive.google.com/file/d/1/view")).toBe(true);
    expect(urlValida("http://a.test/x")).toBe(true);
  });

  /** O endereço vai para o WhatsApp de um cliente. */
  it("⚠ recusa javascript:, data: e texto solto", () => {
    expect(urlValida("javascript:alert(1)")).toBe(false);
    expect(urlValida("data:text/html,<script>")).toBe(false);
    expect(urlValida("drive.google.com/file")).toBe(false);
    expect(urlValida("")).toBe(false);
  });
});

describe("documentosDoProduto", () => {
  const config = lerDocumentos(LITORAL);

  it("acha o produto sem depender de acento nem de caixa", () => {
    expect(documentosDoProduto(config, "endereco fiscal litoral")).toHaveLength(3);
    expect(documentosDoProduto(config, "ENDEREÇO FISCAL LITORAL")).toHaveLength(3);
  });

  /**
   * ⚠ Litoral, Batial, Abissal e Comércio são PRÉDIOS diferentes. Mandar a
   * documentação do endereço errado é pior do que não mandar nenhuma.
   */
  it("produto sem seção, desconhecido ou vazio devolve nada — nunca a de outro", () => {
    expect(documentosDoProduto(config, "Endereço Fiscal Batial")).toEqual([]);
    expect(documentosDoProduto(config, null)).toEqual([]);
    expect(documentosDoProduto(config, "")).toEqual([]);
  });
});

describe("blocoDaDocumentacao", () => {
  it("sem documento, não escreve nada: a mensagem fica como era", () => {
    expect(blocoDaDocumentacao([])).toEqual([]);
  });

  it("lista um por linha, com o nome na frente", () => {
    const linhas = blocoDaDocumentacao([
      { nome: "AVCB", url: "https://a.test/1" },
      { nome: "ART", url: "https://a.test/2" },
    ]);
    expect(linhas).toContain("AVCB: https://a.test/1");
    expect(linhas).toContain("ART: https://a.test/2");
  });

  /** Se a equipe puser tudo numa pasta, a mensagem encolhe sozinha. */
  it("tudo no mesmo endereço vira UM link", () => {
    const linhas = blocoDaDocumentacao([
      { nome: "AVCB", url: "https://a.test/pasta" },
      { nome: "ART", url: "https://a.test/pasta" },
    ]);
    expect(linhas.filter((l) => l.includes("http"))).toEqual(["https://a.test/pasta"]);
  });
});
