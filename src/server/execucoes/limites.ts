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
 * Passou daqui, quem gravou `RUNNING` morreu sem conseguir fechar a linha — em
 * geral um deploy, que reinicia o processo com o turno no meio — e aí não
 * existe ninguém para receber o recado de parada. É a régua do botão "parar" e
 * do encerramento automático do vigia (`orfas.ts`).
 *
 * ⚠ Eram 10 minutos, na conta de que "o vigia escala a conversa em 3". Vale
 * para o atendimento, não para o resto: medido em 21/09/2026, o turno mais
 * longo que terminou BEM em 30 dias foi de 945 s — o agente de contratos, por
 * gatilho HTTP, em 26/08, antes da preferência por vazão da OpenRouter. Com 10
 * minutos, "parar" encerraria como órfã uma execução viva, que depois seguiria
 * gravando. 30 é o dobro do maior medido, e o SDK da OpenRouter, sem prazo
 * nosso, pode passar 30 minutos numa chamada só (10 de espera × 3 tentativas).
 */
export const IDADE_DE_ZUMBI_MS = 30 * 60 * 1000;

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
