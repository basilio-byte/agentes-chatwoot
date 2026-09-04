import { unstable_isUnrecognizedActionError } from "next/navigation";

/**
 * Reconhecer, no cliente, a falha de server action que parece defeito e não é.
 *
 * ⚠ **O sintoma que motivou isto foi diagnosticado como "problema de
 * armazenamento", em 04/09/2026.** Depois de um deploy, uma aba aberta continua
 * com o JavaScript da build ANTERIOR e chama ações por ids que a build nova não
 * tem. O servidor responde `x-nextjs-action-not-found: 1`, o cliente do Next
 * lança `UnrecognizedActionError`, e o painel — que embrulhava tudo em
 * `catch {}` — mostrava "tente de novo" ou, no formulário, absolutamente nada.
 *
 * O operador salvava o prompt, nada acontecia, ele reabria e o texto antigo
 * estava lá. Parecia banco de dados. Era uma aba velha, e um `catch` que
 * impedia o Next de se recuperar sozinho.
 *
 * Um `F5` resolve — mas só depois de alguém descobrir que era isso.
 */

/**
 * A ação existe no navegador e não existe mais no servidor.
 *
 * Usa a função do próprio Next em vez de casar mensagem de erro. Ela é
 * `unstable_`, então há o recuo por `name` logo abaixo: o nome da classe é o
 * que sobrevive à minificação e a uma renomeação da API.
 */
export function ehVersaoDesatualizada(erro: unknown): boolean {
  if (unstable_isUnrecognizedActionError(erro)) return true;
  return (
    typeof erro === "object" &&
    erro !== null &&
    (erro as { name?: unknown }).name === "UnrecognizedActionError"
  );
}

/**
 * `redirect()` e `notFound()` viajam como exceção de fluxo de controle.
 *
 * ⚠ Capturá-los foi metade do defeito: `exigirSessao()` chama
 * `redirect("/login")` quando a sessão cai, e o `catch` da tela de execuções
 * transformava isso em "tente de novo" — o operador nunca ia parar no login e
 * nunca ficava sabendo que a sessão tinha expirado. Quem pegar um erro de ação
 * precisa relançar estes.
 */
export function ehFluxoDeControle(erro: unknown): boolean {
  if (typeof erro !== "object" || erro === null) return false;
  const digest = (erro as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

/**
 * O texto muda conforme haja ou não trabalho não salvo na tela.
 *
 * Recarregar sozinho seria pior que o defeito num formulário: o prompt que a
 * pessoa acabou de escrever sumiria junto. Por isso quem tem texto na tela é
 * avisado para copiar ANTES.
 */
export const AVISO_DESATUALIZADO = {
  semPerda:
    "Esta aba está com uma versão antiga do painel — houve uma atualização desde que você a abriu. Recarregue a página para continuar.",
  comPerda:
    "Esta aba está com uma versão antiga do painel — houve uma atualização desde que você a abriu, e por isso nada foi salvo. COPIE o que você escreveu, recarregue a página e cole de volta.",
} as const;
