import { describe, expect, it } from "vitest";
import { contarMudancas, diffPorLinha, formatarDiff } from "./diff";

describe("diff de prompt", () => {
  it("prompt igual não tem mudança", () => {
    const linhas = diffPorLinha("a\nb\nc", "a\nb\nc");
    expect(contarMudancas(linhas)).toEqual({ adicionadas: 0, removidas: 0 });
  });

  it("uma linha trocada no meio vira uma removida e uma adicionada", () => {
    const linhas = diffPorLinha("a\nb\nc", "a\nB\nc");
    expect(contarMudancas(linhas)).toEqual({ adicionadas: 1, removidas: 1 });
    expect(linhas.filter((l) => l.tipo === "igual").map((l) => l.texto)).toEqual(["a", "c"]);
  });

  it("linha inserida não marca o resto como mudado", () => {
    // É o erro de diff ingênuo por posição: inserir uma linha no topo faria o
    // prompt inteiro parecer reescrito, e a aprovação viraria às cegas.
    const antes = ["regra 1", "regra 2", "regra 3", "regra 4"].join("\n");
    const depois = ["NOVA", "regra 1", "regra 2", "regra 3", "regra 4"].join("\n");
    expect(contarMudancas(diffPorLinha(antes, depois))).toEqual({ adicionadas: 1, removidas: 0 });
  });

  it("reconstrói os dois lados a partir do diff", () => {
    const antes = "x\ny\nz\nw";
    const depois = "x\nz\nnovo\nw\nfim";
    const linhas = diffPorLinha(antes, depois);
    const ladoA = linhas.filter((l) => l.tipo !== "adicionada").map((l) => l.texto).join("\n");
    const ladoB = linhas.filter((l) => l.tipo !== "removida").map((l) => l.texto).join("\n");
    expect(ladoA).toBe(antes);
    expect(ladoB).toBe(depois);
  });

  it("o texto formatado marca as mudanças e esconde o que está longe", () => {
    const antes = Array.from({ length: 20 }, (_, i) => `linha ${i}`).join("\n");
    const depois = antes.replace("linha 10", "linha DEZ");
    const texto = formatarDiff(diffPorLinha(antes, depois), 1);
    expect(texto).toContain("- linha 10");
    expect(texto).toContain("+ linha DEZ");
    expect(texto).toContain("  linha 9");
    expect(texto).not.toContain("linha 2\n");
    expect(texto.startsWith("…")).toBe(false);
  });
});
