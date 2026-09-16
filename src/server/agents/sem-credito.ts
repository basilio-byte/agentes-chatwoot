/**
 * Falta de crédito na OpenRouter (HTTP 402).
 *
 * Existe porque isto **não é instabilidade**, e era tratado como se fosse. O
 * BullMQ reexecuta o turno inteiro, o modelo é chamado de novo, o 402 volta
 * igual e a rede de segurança manda outro "Tive uma instabilidade" ao cliente —
 * uma vez por tentativa, mais o aviso da última. Em 08/09/2026 foram 29
 * execuções com 402 em 12 conversas, e nenhuma delas dizia à equipe qual era o
 * problema de verdade: o saldo tinha acabado, e nada voltaria a funcionar até
 * alguém repor.
 *
 * Tentar de novo não resolve, então os workers param no primeiro 402 e deixam a
 * causa escrita onde alguém lê: nota interna na conversa, `AgentRun.error` e a
 * tela de Consumo.
 */

/**
 * Prefixo que marca a execução no painel.
 *
 * Sem ele, `AgentRun.error` guarda o despejo cru do SDK (`402 {"error":...}`) e
 * quem abre Execuções precisa saber o que é um 402 para entender que faltou
 * dinheiro. É também o que a tela de Consumo procura para dizer que já houve
 * atendimento perdido por falta de saldo.
 */
export const MARCA_SEM_CREDITO = "[sem crédito na OpenRouter]";

/**
 * Nota interna na conversa que ficou sem resposta.
 *
 * O cliente recebe o aviso genérico de instabilidade — do lado dele, é o que
 * aconteceu. Quem precisa da causa é a equipe, e nota interna é o único canal
 * que o cliente não lê.
 */
export const NOTA_SEM_CREDITO =
  "⚠️ Sem crédito na OpenRouter: o agente não conseguiu responder e não vai " +
  "conseguir em nenhuma conversa até alguém repor o saldo. O cliente recebeu " +
  "só o aviso de instabilidade — alguém precisa assumir este atendimento. " +
  "O saldo está no painel, em Consumo.";

/** Motivo gravado nas origens sem cliente (gatilho, agendamento, conversa). */
export const MOTIVO_SEM_CREDITO =
  "sem crédito na OpenRouter — reponha o saldo (o painel mostra em Consumo)";

/**
 * Reconhece o 402 da OpenRouter.
 *
 * O SDK da OpenAI expõe o código em `status`, que é o caminho confiável. A
 * checagem pela mensagem existe para o erro que chega reembrulhado (ou já
 * marcado) e exige as DUAS pistas — só "402" solto casaria com um nome de
 * modelo ou com um número dentro de retorno de tool.
 */
export function ehSemCredito(erro: unknown): boolean {
  if (!erro || typeof erro !== "object") return false;

  if ((erro as { status?: unknown }).status === 402) return true;

  const mensagem = (erro as { message?: unknown }).message;
  if (typeof mensagem !== "string") return false;
  if (mensagem.startsWith(MARCA_SEM_CREDITO)) return true;

  return (
    /\b402\b/.test(mensagem) &&
    /(cr[ée]dit|payment required)/i.test(mensagem)
  );
}

/** Põe a marca na frente da mensagem original, sem perdê-la nem duplicar. */
export function marcarSemCredito(mensagem: string): string {
  return mensagem.startsWith(MARCA_SEM_CREDITO)
    ? mensagem
    : `${MARCA_SEM_CREDITO} ${mensagem}`;
}
