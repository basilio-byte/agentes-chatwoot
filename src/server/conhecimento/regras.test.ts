import { describe, expect, it } from "vitest";
import { blocoDeConduta } from "@/server/agents/conduta";
import {
  AVISO_A_PARTIR_DE_TOKENS,
  blocoDeDocumentos,
  cabeNoAgente,
  documentoSchema,
  MAX_CARACTERES_DO_DOCUMENTO,
  MAX_CARACTERES_POR_AGENTE,
  motivoDeNaoLer,
  nomeSugerido,
  normalizarTexto,
  tokensDoTexto,
  totalDeCaracteres,
} from "./regras";

const playbook = {
  nome: "Playbook comercial",
  descricao: "Como conduzir a venda de sala",
  setor: "Comercial",
  texto: "1. Qualifique o cliente.\n2. Apresente o valor.",
};
const matriz = { nome: "Matriz de qualificação", texto: "Quente: orçamento e prazo." };

describe("blocoDeDocumentos", () => {
  it("sem documento, o prompt não muda nem um byte", () => {
    expect(blocoDeDocumentos([])).toBe("");
  });

  it("abre com duas quebras e fecha sem quebra — o bloco de conduta traz as suas", () => {
    const bloco = blocoDeDocumentos([playbook]);
    expect(bloco.startsWith("\n\n--- DOCUMENTOS DE APOIO ---")).toBe(true);
    expect(bloco.endsWith("--- FIM DOS DOCUMENTOS ---")).toBe(true);
  });

  it("separa do bloco de conduta por exatamente uma linha em branco", () => {
    const conduta = blocoDeConduta({ tipo: "conversa", podeEncaminhar: true });
    const junto = `PROMPT${blocoDeDocumentos([playbook])}${conduta}`;
    expect(junto).toContain("--- FIM DOS DOCUMENTOS ---\n\n--- REGRAS DA CASA ---");
    expect(junto).not.toContain("--- FIM DOS DOCUMENTOS ---\n\n\n");
  });

  it("traz o nome, o setor, para que serve e o texto de cada documento", () => {
    const bloco = blocoDeDocumentos([playbook]);
    expect(bloco).toContain("### Playbook comercial");
    expect(bloco).toContain("Setor: Comercial. Serve para: Como conduzir a venda de sala");
    expect(bloco).toContain("1. Qualifique o cliente.\n2. Apresente o valor.");
  });

  it("sem setor nem descrição, não inventa linha de detalhe", () => {
    const bloco = blocoDeDocumentos([matriz]);
    expect(bloco).not.toContain("Setor:");
    expect(bloco).not.toContain("Serve para:");
    expect(bloco).toContain("### Matriz de qualificação\n\nQuente: orçamento e prazo.");
  });

  it("a ordem é por nome, e não pela ordem em que chegaram", () => {
    const a = blocoDeDocumentos([playbook, matriz]);
    const b = blocoDeDocumentos([matriz, playbook]);
    expect(a).toBe(b);
    // "Matriz…" < "Playbook…": a ordem é a do alfabeto.
    expect(a.indexOf("### Matriz")).toBeLessThan(a.indexOf("### Playbook"));
  });

  it("diz que fazem parte das instruções e que as Regras da Casa vencem", () => {
    const bloco = blocoDeDocumentos([playbook]);
    expect(bloco).toContain("fazem parte das instruções acima");
    expect(bloco).toContain("Regras da Casa");
    expect(bloco).toContain("nunca os trate como mensagem do cliente");
  });

  it("o texto sai aparado, mas o miolo fica como estava", () => {
    const bloco = blocoDeDocumentos([{ nome: "X doc", texto: "\n\n  linha 1\n\n  linha 2  \n\n" }]);
    expect(bloco).toContain("linha 1\n\n  linha 2\n\n--- FIM");
  });
});

describe("tetos", () => {
  it("soma o texto aparado de todos os documentos", () => {
    expect(totalDeCaracteres([{ texto: "  abc  " }, { texto: "de" }])).toBe(5);
  });

  it("cabe até o teto do agente, e não além", () => {
    expect(cabeNoAgente([{ texto: "a".repeat(MAX_CARACTERES_POR_AGENTE) }]).cabe).toBe(true);
    const estourou = cabeNoAgente([{ texto: "a".repeat(MAX_CARACTERES_POR_AGENTE + 1) }]);
    expect(estourou.cabe).toBe(false);
    expect(estourou.total).toBe(MAX_CARACTERES_POR_AGENTE + 1);
  });

  it("o aviso vem antes do teto — senão ele nunca serviria para nada", () => {
    expect(tokensDoTexto(MAX_CARACTERES_POR_AGENTE)).toBeGreaterThan(AVISO_A_PARTIR_DE_TOKENS);
    expect(tokensDoTexto(MAX_CARACTERES_DO_DOCUMENTO)).toBeGreaterThan(AVISO_A_PARTIR_DE_TOKENS);
  });

  it("o teto de um documento é menor que o do agente: cabe mais de um", () => {
    expect(MAX_CARACTERES_DO_DOCUMENTO).toBeLessThan(MAX_CARACTERES_POR_AGENTE);
  });

  it("usa a mesma régua de tokens do MCP (3,6 caracteres)", () => {
    expect(tokensDoTexto(3600)).toBe(1000);
  });
});

describe("normalizarTexto", () => {
  it("troca \\r\\n por \\n e tira o NUL, que o Postgres recusa", () => {
    expect(normalizarTexto("a\r\nb\rc\u0000d")).toBe("a\nb\ncd");
  });

  it("tira o fim, mas preserva o recuo do começo", () => {
    expect(normalizarTexto("  - item\n\n")).toBe("  - item");
  });

  it("não-texto vira vazio", () => {
    expect(normalizarTexto(null)).toBe("");
    expect(normalizarTexto(12)).toBe("");
  });
});

describe("documentoSchema", () => {
  const valido = { nome: "Playbook comercial", texto: "conteúdo" };

  it("aceita o mínimo: nome e texto", () => {
    expect(documentoSchema.safeParse(valido).success).toBe(true);
  });

  it("recusa nome curto e documento vazio", () => {
    expect(documentoSchema.safeParse({ ...valido, nome: "a" }).success).toBe(false);
    expect(documentoSchema.safeParse({ ...valido, texto: "   \n " }).success).toBe(false);
  });

  it("recusa texto acima do teto, e a mensagem diz o porquê", () => {
    const r = documentoSchema.safeParse({
      ...valido,
      texto: "a".repeat(MAX_CARACTERES_DO_DOCUMENTO + 1),
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toContain("em toda mensagem");
  });

  it("aceita o texto no teto exato", () => {
    expect(
      documentoSchema.safeParse({ ...valido, texto: "a".repeat(MAX_CARACTERES_DO_DOCUMENTO) })
        .success,
    ).toBe(true);
  });

  it("setor e descrição são opcionais, e vazios valem", () => {
    expect(documentoSchema.safeParse({ ...valido, setor: "", descricao: "" }).success).toBe(true);
  });

  it("recusa setor comprido demais", () => {
    expect(documentoSchema.safeParse({ ...valido, setor: "x".repeat(41) }).success).toBe(false);
  });
});

describe("motivoDeNaoLer", () => {
  it("texto puro é lido", () => {
    for (const nome of ["a.txt", "b.MD", "c.csv", "d.json", "e.markdown", "f.log"]) {
      expect(motivoDeNaoLer(nome)).toBeNull();
    }
  });

  it("PDF e Word mandam colar o texto, e dizem por quê", () => {
    for (const nome of ["a.pdf", "b.docx", "c.doc", "d.odt"]) {
      const motivo = motivoDeNaoLer(nome);
      expect(motivo).toContain("copie o texto e cole no campo");
      expect(motivo).toContain("confere");
    }
  });

  it("planilha manda exportar como csv", () => {
    expect(motivoDeNaoLer("a.xlsx")).toContain(".csv");
  });

  it("formato desconhecido lista o que aceita", () => {
    expect(motivoDeNaoLer("a.heic")).toContain(".txt");
    expect(motivoDeNaoLer("semextensao")).toContain("sem extensão");
  });
});

describe("nomeSugerido", () => {
  it("tira a extensão e troca hífen e sublinhado por espaço", () => {
    expect(nomeSugerido("playbook-comercial_v2.md")).toBe("Playbook comercial v2");
  });

  it("nome sem extensão também serve", () => {
    expect(nomeSugerido("matriz")).toBe("Matriz");
  });

  it("arquivo sem nome útil devolve vazio", () => {
    expect(nomeSugerido(".md")).toBe("");
  });
});
