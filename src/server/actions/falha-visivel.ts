import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";

/**
 * Faz uma server action falhar em VOZ ALTA.
 *
 * Escrito em 04/09/2026, depois de dois sintomas em produção que o painel
 * escondia por construção: expandir uma execução mostrava "Não foi possível
 * carregar o detalhe. Tente de novo." para qualquer causa, e salvar o prompt de
 * um agente não mostrava absolutamente nada — nem erro, nem confirmação. O
 * operador concluiu, com razão, que havia algo errado no armazenamento; o que
 * havia era uma exceção do servidor que ninguém tinha como ver.
 *
 * Uma server action que lança some duas vezes: o React descarta a rejeição no
 * cliente, e o Next mascara a mensagem em produção (só o `digest` atravessa).
 * O resultado é uma tela parada e um log vazio.
 *
 * Este envoltório resolve os dois lados: grava o erro INTEIRO no log do
 * servidor com um código curto, e devolve ao operador uma frase que carrega o
 * mesmo código. Aí a linha do log e a queixa da tela se encontram.
 */

/**
 * `redirect()` e `notFound()` do Next são fluxo de controle, não erro: eles
 * LANÇAM de propósito, e a doc é explícita em chamá-los fora de `try/catch`.
 *
 * ⚠ Capturá-los foi metade do defeito de 04/09: `exigirSessao()` chama
 * `redirect("/login")` quando a sessão morre, e o `catch` do componente de
 * execuções transformava isso em "tente de novo" — o operador nunca era levado
 * ao login e nunca ficava sabendo que a sessão tinha caído.
 */
function ehFluxoDeControle(erro: unknown): boolean {
  if (typeof erro !== "object" || erro === null) return false;
  const digest = (erro as { digest?: unknown }).digest;
  return (
    typeof digest === "string" &&
    (digest.startsWith("NEXT_REDIRECT") || digest === "NEXT_NOT_FOUND")
  );
}

/** O que a tela mostra quando a ação falha por motivo inesperado. */
export type FalhaDeAcao = { erro: string; codigo: string };

/**
 * Roda a ação e, se ela falhar por algo que não seja fluxo de controle, grava
 * o erro e devolve `aoFalhar(falha)`.
 *
 * O tipo de retorno é o da própria ação: cada uma decide como a falha entra no
 * seu estado (`EstadoFormulario`, `EstadoDaParada`, o que for), e nenhuma
 * precisa aprender um formato novo.
 */
export async function comFalhaVisivel<T>(
  acao: string,
  executar: () => Promise<T>,
  aoFalhar: (falha: FalhaDeAcao) => T,
): Promise<T> {
  try {
    return await executar();
  } catch (erro) {
    if (ehFluxoDeControle(erro)) throw erro;

    // Curto e legível em voz alta: o operador vai ditar isto para quem lê o
    // log. Um uuid inteiro ninguém copia certo.
    const codigo = randomUUID().slice(0, 8);

    logger.error(
      {
        acao,
        codigo,
        // `err` é o campo que o pino serializa com stack; sem ele a causa real
        // vira "[object Object]" e o log não serve para nada.
        err: erro,
      },
      "server action falhou",
    );

    return aoFalhar({
      erro: `Não deu para concluir (código ${codigo}). O erro completo está no log do servidor — procure por este código.`,
      codigo,
    });
  }
}
