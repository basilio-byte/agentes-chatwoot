/**
 * Os tetos da tela de Execuções.
 *
 * ⚠ **Moram aqui, e não em `actions/execucoes.ts`, por obrigação do Next.** Um
 * arquivo `"use server"` só pode exportar função assíncrona — exportar um
 * número derruba a avaliação do módulo INTEIRO em runtime, e com ela todas as
 * ações daquele arquivo.
 *
 * Isso esteve em produção. `IDADE_DE_ZUMBI_MS` morava no arquivo de ações desde
 * o recurso de parar execução, e o sintoma era expandir QUALQUER execução e
 * receber "An error occurred in the Server Components render". A mensagem real
 * — `A "use server" file can only export async functions, found number` — só
 * aparecia no log do contêiner.
 *
 * ⚠ E o build NÃO protege disso de forma confiável: o Turbopack reprova o
 * literal (`1_500_000`) e deixa passar a expressão (`10 * 60 * 1000`), que
 * então só quebra rodando. Quem protege é `use-server.test.ts`.
 */

/**
 * Idade a partir da qual uma execução `RUNNING` é tratada como zumbi.
 *
 * Turno legítimo não chega perto disso: o vigia já escala a conversa em 3
 * minutos, e o teto de iterações de tool limita o resto. Passou daqui, quem
 * gravou `RUNNING` morreu sem conseguir fechar a linha — e aí não existe
 * ninguém para receber o recado de parada.
 */
export const IDADE_DE_ZUMBI_MS = 10 * 60 * 1000;

/**
 * Teto do detalhe INTEIRO, somando transcrição e chamadas.
 *
 * `TETO_DE_TEXTO` limita cada bloco em quarenta mil caracteres, e isso não
 * limita o total: quem decide quantas chamadas existem é o modelo, e o runner
 * executa todas as de uma rodada em paralelo. Doze rodadas com vinte tools cada
 * dariam nove megabytes numa resposta só — medido em 04/09/2026.
 *
 * Cortar aqui transforma um detalhe impossível de carregar em "carreguei o
 * começo e digo o que ficou de fora", que é a mesma doutrina do corte por
 * bloco: cortar é honesto desde que o corte apareça.
 */
export const TETO_DO_DETALHE = 1_500_000;
