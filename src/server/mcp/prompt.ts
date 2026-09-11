import { createHash } from "node:crypto";

/**
 * A alteração de prompt pelo MCP: dois passos, e nenhum estado no servidor.
 *
 * `propor` devolve o diff e dois carimbos — `baseHash` (o prompt de onde se
 * partiu) e `hashDaProposta` (o prompt que vai resultar). `aplicar` recebe a
 * MESMA alteração com os dois carimbos e só grava se o prompt do banco ainda
 * for o de base E se o resultado recalculado for o que foi mostrado.
 *
 * ⚠ O segundo carimbo é o que importa. Sem ele, o assistente poderia mostrar
 * uma alteração, ouvir "pode aplicar" e aplicar outra — reescrevendo o texto de
 * memória no segundo passo, sem má-fé nenhuma. Com ele, o que se aprova é o que
 * se grava, byte a byte.
 */

/**
 * 16 hexadecimais = 64 bits. Colisão acidental não existe na escala de um
 * painel, e é curto o bastante para o modelo copiar sem errar um caractere.
 */
export function carimbo(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex").slice(0, 16);
}

export type Substituicao = { trecho: string; por: string };

export type Alteracao =
  | { tipo: "inteiro"; novoPrompt: string }
  | { tipo: "substituicoes"; substituicoes: Substituicao[] };

export type ResultadoDaAlteracao =
  | {
      ok: true;
      /** Exatamente o que vai para o banco. */
      prompt: string;
      /** Os dois lados com quebra de linha normalizada — é o que o diff compara. */
      antes: string;
      depois: string;
    }
  | { ok: false; erro: string };

/**
 * ⚠ O prompt salvo pelo painel costuma ter `\r\n`: o formulário serializa a
 * quebra de linha do `<textarea>` assim. O assistente lê o JSON e escreve `\n`.
 * Sem normalizar, nenhum trecho com quebra de linha seria encontrado, e o diff
 * de uma troca de uma palavra mostraria o prompt inteiro como reescrito.
 */
export function normalizarQuebras(texto: string): string {
  return texto.replace(/\r\n?/g, "\n");
}

export function aplicarAlteracao(
  base: string,
  alteracao: Alteracao,
): ResultadoDaAlteracao {
  // O resultado sai no MESMO estilo de quebra do prompt que já existe, para a
  // próxima edição pelo painel não virar um diff de todas as linhas.
  const quebra = base.includes("\r\n") ? "\r\n" : "\n";
  const antes = normalizarQuebras(base);

  let depois: string;
  if (alteracao.tipo === "inteiro") {
    depois = normalizarQuebras(alteracao.novoPrompt);
  } else {
    depois = antes;
    for (const [i, s] of alteracao.substituicoes.entries()) {
      const trecho = normalizarQuebras(s.trecho);
      const n = trecho ? contarOcorrencias(depois, trecho) : 0;

      if (!trecho) {
        return { ok: false, erro: `Substituição ${i + 1}: o trecho está vazio.` };
      }
      // ⚠ Zero é o assistente lembrando errado o texto; aplicar as outras e
      // pular esta faria a alteração sair pela metade, calada.
      if (n === 0) {
        return {
          ok: false,
          erro: `Substituição ${i + 1}: o trecho não foi encontrado no prompt atual (já com as substituições anteriores aplicadas). Copie-o exatamente como aparece em ver_agente. Nada foi alterado.`,
        };
      }
      // Mais de uma é ambiguidade que ninguém escolheu resolver: trocar todas
      // mexeria numa regra que não era o alvo.
      if (n > 1) {
        return {
          ok: false,
          erro: `Substituição ${i + 1}: o trecho aparece ${n} vezes. Inclua mais texto em volta para que ele apareça uma vez só. Nada foi alterado.`,
        };
      }

      // Fatiamento, e não `String.replace`: no `replace`, um `$&` ou `$1`
      // escrito no texto novo seria interpretado como padrão de substituição.
      const pos = depois.indexOf(trecho);
      depois =
        depois.slice(0, pos) +
        normalizarQuebras(s.por) +
        depois.slice(pos + trecho.length);
    }
  }

  const prompt = quebra === "\n" ? depois : depois.replace(/\n/g, "\r\n");
  return { ok: true, prompt, antes, depois };
}

/** Conta sobrepostas também: "aa" em "aaa" é ambíguo, e deve ser recusado. */
function contarOcorrencias(texto: string, trecho: string): number {
  let n = 0;
  let desde = 0;
  for (;;) {
    const i = texto.indexOf(trecho, desde);
    if (i === -1) return n;
    n++;
    desde = i + 1;
  }
}
