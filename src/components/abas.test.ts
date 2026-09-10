import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A tira de abas não pode esconder aba nenhuma.
 *
 * ⚠ Esta regra foi quebrada DUAS VEZES, e as duas em produção:
 *
 * 1. 28/08/2026 — a integração do Google virou a sexta aba de Integrações e
 *    levou a tira a sete, empurrando "Leitura de mídia" para fora da tela. Foi
 *    o próprio usuário que desconfiou, olhando uma captura: "a opção do Google
 *    está sendo mostrada cortada, não sei se pode haver mais itens ocultos à
 *    frente dele". Havia: uma aba inteira.
 * 2. 10/09/2026 — mesmo defeito cobrando de novo. Ele precisava do campo de
 *    instrução de leitura de documento, abriu Integrações, e foi procurar na
 *    aba "Documentos" (que é a conferência de CPF/CNH, outra coisa) porque
 *    "Leitura de mídia" continuava atrás da borda direita.
 *
 * Entre uma e outra houve uma tentativa de conserto que NÃO funcionou: sombra
 * em degradê nas pontas, `ResizeObserver` e a aba ativa rolando para dentro da
 * vista. Falhou pelo motivo que este teste existe para lembrar — **dica visual
 * depende de a pessoa reparar nela**, e a prova de que não repara já aconteceu
 * duas vezes com a mesma pessoa, na mesma tela.
 *
 * O conserto é estrutural: a tira QUEBRA EM LINHAS. Custa altura, e altura se
 * vê. Este teste trava isso porque a tentação de voltar a rolar é grande — é
 * mais bonito, cabe numa linha, e o defeito só aparece na oitava integração.
 *
 * Varre o arquivo-fonte, no mesmo espírito de `actions/use-server.test.ts`: não
 * há jsdom neste projeto, e mesmo com ele um teste de render não pegaria o caso
 * (o overflow só se manifesta numa largura específica, com um número específico
 * de abas).
 */

const ARQUIVO = readFileSync(
  join(process.cwd(), "src/components/abas.tsx"),
  "utf8",
);

/**
 * O arquivo SEM comentário.
 *
 * ⚠ Não é preciosismo: a primeira versão deste teste reprovou o conserto certo,
 * porque o comentário que explica o que foi REMOVIDO cita `ResizeObserver` e
 * `scrollIntoView` pelo nome. Um teste que proíbe falar do defeito impede
 * justamente o comentário que evita o defeito voltar.
 */
const FONTE = ARQUIVO.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /(^|[^:])\/\/.*$/gm,
  "$1",
);

/** A linha do `role="tablist"` até o fim das classes dele. */
function classesDaTira(): string {
  const trecho = FONTE.split('role="tablist"')[1] ?? "";
  const ateOFecho = trecho.split(">")[0] ?? "";
  return ateOFecho;
}

describe("a tira de abas nunca esconde uma aba", () => {
  it("quebra em linhas", () => {
    expect(classesDaTira()).toContain("flex-wrap");
  });

  it("⚠ NÃO rola na horizontal", () => {
    // `overflow-x-auto`, `overflow-auto`, `overflow-scroll` — qualquer um
    // devolve o defeito. A busca é no arquivo inteiro, e não só na tira, porque
    // um wrapper com overflow tem exatamente o mesmo efeito.
    expect(FONTE).not.toMatch(/overflow-(x-)?(auto|scroll|hidden)/);
  });

  it("⚠ não esconde barra de rolagem", () => {
    // `.sem-barra` foi removida do globals.css junto com a rolagem. Esconder a
    // barra foi o que fez a aba sumir SEM SINAL NENHUM: com a barra à vista,
    // alguém teria percebido que a tira continuava.
    expect(FONTE).not.toContain("sem-barra");
  });

  it("não depende de sombra nem de rolagem programática para se explicar", () => {
    // Se estes voltarem, é porque alguém reintroduziu a rolagem — eles só
    // existiam para administrá-la.
    expect(FONTE).not.toContain("ResizeObserver");
    expect(FONTE).not.toContain("scrollIntoView");
    expect(FONTE).not.toContain("scrollLeft");
  });
});

describe("o que a tira continua garantindo", () => {
  it("toda aba vira um botão de verdade, com papel de aba", () => {
    // Quebrar em linhas não pode ter custado a semântica: leitor de tela e
    // navegação por setas dependem disto.
    expect(FONTE).toContain('role="tab"');
    expect(FONTE).toContain("aria-selected");
    expect(FONTE).toContain("aria-controls");
  });

  it("a troca de aba não passa pelo router", () => {
    // `router.replace` reexecuta o componente de servidor e mata a troca
    // instantânea — está escrito no AGENTS.md e vale independente do layout.
    expect(FONTE).toContain("history.replaceState");
    expect(FONTE).not.toContain("router.replace");
  });
});
