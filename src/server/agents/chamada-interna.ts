/**
 * Chamada interna: um agente aciona outro em segundo plano, no meio do próprio
 * turno, e recebe o resultado de volta — sem passar a conversa e sem o cliente
 * ver nada.
 *
 * Existe porque o registro no CRM de Atendimentos tem de acontecer "tipo em
 * background" (palavras do usuário, 14/09/2026), no momento que o prompt de
 * cada agente de atendimento define, e sem depender de resposta do cliente. A
 * transferência não serve para isso por construção:
 *
 * - todo salto manda o `aviso` ao cliente — ida e volta são DUAS mensagens;
 * - o colega transferido roda como conversa, e a cauda de conversa mandava
 *   confirmar com o cliente antes de registrar;
 * - na volta, o agente de origem é executado do zero com a MESMA mensagem do
 *   cliente e um bastão que manda se apresentar — reapresenta e pode acionar o
 *   colega de novo;
 * - enquanto o colega roda, ele é o dono da conversa: se falhar no meio, a
 *   próxima mensagem do cliente cai num integrador.
 *
 * Aqui o agente acionado roda DENTRO da ferramenta de quem chamou, e quem chamou
 * continua o mesmo raciocínio com o resultado na mão. Este módulo é puro, para
 * as regras de quem pode ser acionado e do que volta serem testáveis sem banco
 * nem modelo.
 */

export const NOME_DA_FERRAMENTA = "acionar_agente_interno";

/**
 * Ferramentas que falam com o cliente ou passam a conversa de mãos.
 *
 * Um agente acionado em segundo plano não recebe nenhuma delas. Ele não é o
 * dono da conversa, e qualquer uma faria o "segundo plano" aparecer para o
 * cliente — ou entregaria a conversa a outra pessoa enquanto quem acionou ainda
 * está no meio do turno. A própria ferramenta de chamada interna também sai:
 * agente interno não aciona outro. É essa profundidade fixa em um que impede
 * uma cadeia sem fim longe das travas do laço, que só olham transferências.
 */
export const FERRAMENTAS_DE_CANAL: ReadonlySet<string> = new Set([
  "transferir_para_agente",
  "transferir_para_humano",
  "atribuir_para_atendente",
  "atribuir_por_rodizio",
  NOME_DA_FERRAMENTA,
]);

/** O mapa de ferramentas de um turno interno. Não altera o mapa recebido. */
export function semFerramentasDeCanal<T>(
  resolvidas: Map<string, T>,
): Map<string, T> {
  return new Map(
    [...resolvidas].filter(([nome]) => !FERRAMENTAS_DE_CANAL.has(nome)),
  );
}

export type AgenteAcionavel = {
  id: string;
  key: string;
  name: string;
  active: boolean;
};

export type AlvoDaChamada =
  | { tipo: "achado"; agente: AgenteAcionavel }
  | { tipo: "recusado"; erro: string; chavesValidas?: string[] };

/**
 * Quem pode ser acionado.
 *
 * Pela chave (ou pelo id), nunca pelo nome: a chave não muda quando o agente é
 * renomeado, e é ela que o prompt de quem chama escreve. Desligado não roda —
 * desligar o agente interno é o jeito de o operador suspender o serviço sem
 * mexer no prompt de ninguém. Arquivado já chega fora da lista.
 */
export function resolverAgenteInterno(
  equipe: AgenteAcionavel[],
  termo: string,
  chamadorId: string,
): AlvoDaChamada {
  const bruto = termo.trim();
  const alvo = bruto.toLowerCase();
  const achado = equipe.find(
    (a) => a.key.toLowerCase() === alvo || a.id === bruto,
  );

  if (!achado) {
    // Devolve as chaves que existem: o modelo corrige e chama de novo no mesmo
    // turno, em vez de desistir do registro.
    const chavesValidas = equipe
      .filter((a) => a.active && a.id !== chamadorId)
      .map((a) => a.key)
      .sort();
    return {
      tipo: "recusado",
      erro: `Não existe agente com a chave "${bruto}".`,
      chavesValidas,
    };
  }

  if (achado.id === chamadorId) {
    return { tipo: "recusado", erro: "Um agente não aciona a si mesmo." };
  }

  if (!achado.active) {
    return {
      tipo: "recusado",
      erro: `O agente "${achado.key}" está desligado — o pedido não foi executado.`,
    };
  }

  return { tipo: "achado", agente: achado };
}

/**
 * A mensagem que abre o turno do agente acionado.
 *
 * O marcador diz de quem é o pedido. O agente acionado recebe também a conversa
 * com o cliente, e o pedido chega como mensagem de `user` logo depois da última
 * fala dele: sem o marcador, seria lido como se o cliente o tivesse escrito.
 */
export function mensagemDaChamada(args: {
  deNome: string;
  pedido: string;
}): string {
  return [
    `[Pedido interno de ${args.deNome} — não é mensagem do cliente]`,
    args.pedido.trim(),
  ].join("\n");
}

export type FalaDaConversa = { role: "user" | "assistant"; content: string };

/**
 * A conversa que o agente acionado consulta: o histórico de quem chamou MAIS a
 * mensagem que abriu o turno dele.
 *
 * ⚠ Sem a segunda parte, o agente acionado não veria justamente o que o cliente
 * acabou de mandar. No Chatwoot, `montarContexto` tira do histórico as mensagens
 * de entrada do fim e as entrega à parte, como mensagem do turno — e o caso
 * típico é exatamente esse: o cliente manda o comprovante, e é nesse turno que
 * quem atende aciona o CRM. Achado ao preparar o teste de ponta a ponta, antes
 * do deploy.
 *
 * Fora do Chatwoot a mensagem do turno é o pedido da equipe ou o payload, e vai
 * do mesmo jeito: a cauda interna diz que a conversa é consulta, nunca ordem.
 */
export function conversaDaChamada(
  historico: FalaDaConversa[] | undefined,
  mensagemDoTurno: string | undefined,
): FalaDaConversa[] {
  const ultima = mensagemDoTurno?.trim();
  return [
    ...(historico ?? []),
    ...(ultima ? [{ role: "user" as const, content: ultima }] : []),
  ];
}

export type ResultadoDaChamada = {
  /** O agente acionado rodou até o fim e devolveu texto. Não diz se ELE conseguiu. */
  executado: boolean;
  agente: string;
  /** O texto final do agente acionado: é aqui que ele diz o que fez de fato. */
  resultado?: string;
  erro?: string;
  /** Id da execução do agente acionado, para achar em Execuções. */
  execucao: string | null;
  observacao: string;
};

const OBSERVACAO_EXECUTADO =
  "Leia o resultado: é o que o agente fez de fato. Nada disso aparece para o cliente. Siga as suas instruções a partir do passo seguinte.";

const OBSERVACAO_NAO_EXECUTADO =
  "O pedido NÃO foi concluído. Não diga ao cliente que foi feito; siga as suas instruções a partir do passo seguinte.";

/**
 * O que volta para quem acionou.
 *
 * "Executado" exige texto final e nenhum corte por limite de etapas. Um agente
 * que parou no meio pode ter feito metade do serviço — e quem acionou, lendo
 * "executado", diria ao cliente que está tudo certo. O texto parcial vai junto,
 * para quem assumir saber até onde chegou.
 */
export function resultadoDaChamada(args: {
  agente: string;
  resposta: string;
  runId: string;
  atingiuLimite: boolean;
}): ResultadoDaChamada {
  const resposta = args.resposta.trim();

  if (args.atingiuLimite) {
    return {
      executado: false,
      agente: args.agente,
      erro: "O agente parou no limite de etapas antes de terminar.",
      ...(resposta ? { resultado: resposta } : {}),
      execucao: args.runId,
      observacao: OBSERVACAO_NAO_EXECUTADO,
    };
  }

  if (!resposta) {
    return {
      executado: false,
      agente: args.agente,
      erro: "O agente terminou sem devolver resultado.",
      execucao: args.runId,
      observacao: OBSERVACAO_NAO_EXECUTADO,
    };
  }

  return {
    executado: true,
    agente: args.agente,
    resultado: resposta,
    execucao: args.runId,
    observacao: OBSERVACAO_EXECUTADO,
  };
}

/** Recusa ou falha antes de o agente acionado terminar. Nunca parece sucesso. */
export function falhaDaChamada(args: {
  agente: string;
  erro: string;
  runId?: string | null;
}): ResultadoDaChamada {
  return {
    executado: false,
    agente: args.agente,
    erro: args.erro,
    execucao: args.runId ?? null,
    observacao: OBSERVACAO_NAO_EXECUTADO,
  };
}
