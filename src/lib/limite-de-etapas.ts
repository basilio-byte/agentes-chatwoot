/**
 * O turno que para no teto de etapas de ferramenta.
 *
 * Existe porque isto era registrado como **sucesso limpo**, e foi assim que um
 * defeito caro ficou invisível por um dia inteiro.
 *
 * Em 10/11/2026, às 22:13, o agente de contratos gerou o documento na ZapSign,
 * criou o contrato no Conexa, comentou na task — e parou ali, na décima segunda
 * chamada de ferramenta, com `maxToolIterations: 12`. As duas etiquetas que
 * avisam o próximo agente são as etapas 13 e 14 do roteiro dele, e são uma
 * chamada cada. A execução ficou `SUCCESS`, com resposta vazia e `error: null`:
 * nem Execuções, nem as entregas, nem o log diziam que o turno tinha sido
 * cortado. Quem descobriu foi o Diego, no dia seguinte, porque o fluxo seguinte
 * não andou — e a conclusão natural dele foi que as etiquetas "já estão no
 * prompt, mas não subiram", ou seja, que o modelo as tinha ignorado.
 *
 * ⚠ **E a execução continua `SUCCESS`, de propósito.** O runner não lança: se
 * lançasse, o BullMQ reexecutaria o turno inteiro, e o turno não é idempotente
 * — sairiam um segundo documento na ZapSign e um segundo contrato no Conexa, que
 * é uma segunda cobrança recorrente no cliente. Entre uma execução verde com
 * ressalva escrita e um contrato em dobro, a ressalva é barata. O que faltava
 * não era mudar o desfecho; era deixar rastro.
 *
 * A marca vai em `AgentRun.error`, mesmo caminho e mesmo motivo do
 * `[sem crédito na OpenRouter]`: é o campo que a lista de Execuções já traz e
 * que `listar_execucoes` já devolve no MCP.
 */

/**
 * Prefixo que marca a execução no painel.
 *
 * Prefixo, e não frase solta, para a tela poder reconhecer a ressalva e pintá-la
 * de aviso em vez de erro — parar no teto não é falha de provedor nem defeito de
 * código, é configuração curta para o que o prompt pede.
 */
export const MARCA_LIMITE_DE_ETAPAS = "[parou no limite de etapas]";

/**
 * O texto gravado em `AgentRun.error`.
 *
 * Diz o número, porque é ele que alguém vai mudar, e diz o que a frase custou:
 * o que vinha depois da última ferramenta não aconteceu. Sem essa segunda parte
 * a marca informaria o sintoma e esconderia a consequência.
 */
export function marcarLimiteDeEtapas(limite: number): string {
  return (
    `${MARCA_LIMITE_DE_ETAPAS} o turno gastou as ${limite} etapas de ` +
    "ferramenta permitidas e foi cortado antes de terminar: o que o prompt " +
    "manda fazer depois da última ferramenta não foi feito. Suba " +
    "maxToolIterations do agente, ou encurte o roteiro dele."
  );
}

/** Reconhece a ressalva, para a tela não pintar de vermelho o que é aviso. */
export function ehLimiteDeEtapas(registro: string | null | undefined): boolean {
  return typeof registro === "string" && registro.startsWith(MARCA_LIMITE_DE_ETAPAS);
}
