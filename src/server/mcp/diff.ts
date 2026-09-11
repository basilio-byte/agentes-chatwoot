/**
 * Diferença entre dois prompts, linha a linha.
 *
 * Existe para o passo "propor" do MCP: a pessoa aprova ou recusa uma alteração
 * de prompt OLHANDO o que muda. Prompt reescrito inteiro sem diff é aprovação
 * às cegas — e é assim que uma regra some sem ninguém perceber.
 *
 * LCS clássico sobre linhas, depois de cortar prefixo e sufixo comuns (que é o
 * caso comum: mexe-se num trecho, não no prompt todo). Acima do teto de
 * células, desiste do alinhamento fino e mostra o bloco do meio como trocado
 * inteiro — honesto, e sem travar o servidor com um prompt gigante.
 */

export type LinhaDoDiff = {
  tipo: "igual" | "removida" | "adicionada";
  texto: string;
};

const TETO_DE_CELULAS = 4_000_000;

export function diffPorLinha(antes: string, depois: string): LinhaDoDiff[] {
  const a = antes.split("\n");
  const b = depois.split("\n");

  let inicio = 0;
  while (inicio < a.length && inicio < b.length && a[inicio] === b[inicio]) {
    inicio++;
  }

  let fimA = a.length;
  let fimB = b.length;
  while (fimA > inicio && fimB > inicio && a[fimA - 1] === b[fimB - 1]) {
    fimA--;
    fimB--;
  }

  const prefixo = a.slice(0, inicio).map((texto) => ({ tipo: "igual" as const, texto }));
  const sufixo = a.slice(fimA).map((texto) => ({ tipo: "igual" as const, texto }));
  const meioA = a.slice(inicio, fimA);
  const meioB = b.slice(inicio, fimB);

  return [...prefixo, ...alinhar(meioA, meioB), ...sufixo];
}

function alinhar(a: string[], b: string[]): LinhaDoDiff[] {
  if (a.length === 0) return b.map((texto) => ({ tipo: "adicionada", texto }));
  if (b.length === 0) return a.map((texto) => ({ tipo: "removida", texto }));

  if (a.length * b.length > TETO_DE_CELULAS) {
    return [
      ...a.map((texto) => ({ tipo: "removida" as const, texto })),
      ...b.map((texto) => ({ tipo: "adicionada" as const, texto })),
    ];
  }

  // tabela[i][j] = tamanho da maior subsequência comum de a[i..] e b[j..].
  const tabela: Uint32Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      tabela[i][j] =
        a[i] === b[j]
          ? tabela[i + 1][j + 1] + 1
          : Math.max(tabela[i + 1][j], tabela[i][j + 1]);
    }
  }

  const saida: LinhaDoDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      saida.push({ tipo: "igual", texto: a[i] });
      i++;
      j++;
    } else if (tabela[i + 1][j] >= tabela[i][j + 1]) {
      saida.push({ tipo: "removida", texto: a[i] });
      i++;
    } else {
      saida.push({ tipo: "adicionada", texto: b[j] });
      j++;
    }
  }
  while (i < a.length) saida.push({ tipo: "removida", texto: a[i++] });
  while (j < b.length) saida.push({ tipo: "adicionada", texto: b[j++] });
  return saida;
}

export function contarMudancas(linhas: LinhaDoDiff[]) {
  return {
    adicionadas: linhas.filter((l) => l.tipo === "adicionada").length,
    removidas: linhas.filter((l) => l.tipo === "removida").length,
  };
}

/**
 * Texto do diff para a pessoa ler: `+` adicionada, `-` removida, e só
 * `contexto` linhas iguais em volta de cada mudança. O resto vira `…`.
 */
export function formatarDiff(linhas: LinhaDoDiff[], contexto = 2): string {
  const mostrar = new Array<boolean>(linhas.length).fill(false);
  linhas.forEach((linha, i) => {
    if (linha.tipo === "igual") return;
    for (
      let k = Math.max(0, i - contexto);
      k <= Math.min(linhas.length - 1, i + contexto);
      k++
    ) {
      mostrar[k] = true;
    }
  });

  const partes: string[] = [];
  let pulou = false;
  linhas.forEach((linha, i) => {
    if (!mostrar[i]) {
      pulou = true;
      return;
    }
    if (pulou && partes.length > 0) partes.push("…");
    pulou = false;
    const marca = linha.tipo === "adicionada" ? "+ " : linha.tipo === "removida" ? "- " : "  ";
    partes.push(marca + linha.texto);
  });

  return partes.join("\n");
}
