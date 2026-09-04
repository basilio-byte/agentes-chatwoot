import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Num arquivo `"use server"`, TODA exportação precisa ser função assíncrona.
 *
 * ⚠ Esta regra esteve quebrada em produção. `actions/execucoes.ts` exportava
 * `IDADE_DE_ZUMBI_MS = 10 * 60 * 1000` desde o recurso de parar execução, e o
 * efeito não era um erro naquela constante: era a avaliação do MÓDULO INTEIRO
 * falhando em runtime, derrubando todas as ações do arquivo. Expandir qualquer
 * execução no painel devolvia "An error occurred in the Server Components
 * render", e a causa real — `A "use server" file can only export async
 * functions, found number` — só aparecia no log do contêiner.
 *
 * ⚠ **Nem o typecheck nem o build protegem disso de forma confiável.** O `tsc`
 * não conhece a regra. O Turbopack conhece, mas só reprovou o literal
 * (`1_500_000`) e deixou passar a expressão (`10 * 60 * 1000`) — que é
 * justamente a forma que foi para produção e ficou lá.
 *
 * Por isso a guarda é este teste, que lê os arquivos e não depende de nenhuma
 * das duas ferramentas.
 */

const PASTA = join(process.cwd(), "src", "server", "actions");

function arquivosUseServer(): { nome: string; conteudo: string }[] {
  return readdirSync(PASTA)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((nome) => ({
      nome,
      conteudo: readFileSync(join(PASTA, nome), "utf8"),
    }))
    .filter(({ conteudo }) => /^["']use server["'];/m.test(conteudo));
}

describe('arquivos "use server" só exportam função assíncrona', () => {
  it("encontra os arquivos de ação (senão este teste passa sem olhar nada)", () => {
    // Sem isto, renomear a pasta transformaria a guarda num teste que sempre
    // passa — pior que não ter guarda, porque dá confiança.
    const arquivos = arquivosUseServer();
    expect(arquivos.length).toBeGreaterThan(5);
    expect(arquivos.map((a) => a.nome)).toContain("execucoes.ts");
  });

  it("nenhum exporta constante, classe ou função síncrona", () => {
    for (const { nome, conteudo } of arquivosUseServer()) {
      const proibidos = conteudo
        .split("\n")
        .map((linha, i) => ({ linha: linha.trim(), numero: i + 1 }))
        // `export type` e `export interface` somem na compilação e são
        // permitidos; o resto que não seja `export async function` não é.
        .filter(
          ({ linha }) =>
            /^export\s/.test(linha) &&
            !/^export\s+(async\s+function|type\b|interface\b)/.test(linha) &&
            !/^export\s+\{[^}]*\}\s+from\b/.test(linha),
        );

      expect(
        proibidos.map((p) => `${nome}:${p.numero} ${p.linha}`),
        `${nome} exporta algo que não é função assíncrona — isso derruba o módulo INTEIRO em runtime, não só a linha`,
      ).toEqual([]);
    }
  });
});
