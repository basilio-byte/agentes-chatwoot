/**
 * De onde saem os dois links daquela contratação.
 *
 * ⚠ **Não é do comentário da task.** A especificação do Diego manda extrair do
 * texto que o agente gerador escreveu, e isso funciona até alguém editar o
 * comentário, responder dentro dele ou o template mudar. O que o agente fez
 * está gravado estruturado nas `ToolCall` da execução dele — mesma fonte que a
 * barreira de task em dobro e a venda autônoma já usam.
 *
 * ⚠⚠ **E o link de pagamento NÃO vem do contrato.** `conexa_criar_contrato`
 * devolve o endereço da tela de contratos do cliente no ERP
 * (`…r=vendaRecorrente/gerenciarContratos&idCliente=…`), que é painel interno:
 * mandá-lo ao cliente seria mandá-lo para uma tela em que ele não entra.
 * O link do cliente é o da COBRANÇA (`chargeUrl`,
 * `…r=cobranca/fatura&id=<hash>`) — conferido na cobrança real 19733, que o
 * próprio Conexa registra com "visualizações pelo cliente: 2". Por isso daqui
 * sai o **id do contrato**, e quem acha a cobrança é `conferir.ts`, ao vivo.
 */

/** Uma chamada de ferramenta, como a rodada a lê do banco. */
export type Chamada = {
  runId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  createdAt: Date;
};

export type Contratacao = {
  /** Token do documento na ZapSign — por ele se confere a assinatura. */
  documentoZapSign: string | null;
  /** O link que o cliente abre para assinar. */
  linkAssinatura: string | null;
  /** Id do contrato no Conexa — por ele se acha a cobrança. */
  contratoConexa: number | null;
  clienteConexa: number | null;
};

const VAZIA: Contratacao = {
  documentoZapSign: null,
  linkAssinatura: null,
  contratoConexa: null,
  clienteConexa: null,
};

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function inteiro(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * As execuções que tocaram esta task.
 *
 * ⚠ **É o `taskId` do INPUT que amarra**, e ele aparece em qualquer ferramenta
 * do ClickUp daquele turno (ler a task, comentar, etiquetar). O agente roda por
 * gatilho HTTP, sem conversa, então não há `conversationId` para cruzar como a
 * venda autônoma faz.
 */
export function execucoesDaTask(chamadas: Chamada[], taskId: string): Set<string> {
  const runs = new Set<string>();
  for (const c of chamadas) {
    if (idDaTarefa(c.input) === taskId) runs.add(c.runId);
  }
  return runs;
}

/**
 * O id da task no input de uma ferramenta do ClickUp.
 *
 * ⚠⚠ **O parâmetro chama `tarefaId`, não `taskId`.** As ferramentas do ClickUp
 * deste projeto são em português — são 76 `tarefaId` contra nenhum `taskId` —, e
 * esta função procurava o nome errado. O efeito era mudo e total: nenhuma
 * execução casava com task nenhuma, então o acompanhamento achava a task na
 * fila, concluía que não havia contrato nem documento gerados, e não mandava
 * nada. Nunca teria funcionado.
 *
 * Pior, os TESTES passavam: as chamadas de mentira deles foram escritas com
 * `taskId`, então confirmavam a ficção em vez do mundo. Quem desmentiu foi a
 * execução real de 10/11/2026 (`{"tarefaId": "17twvjx2j2w"}`).
 *
 * Os dois nomes são aceitos para o caso de uma ferramenta nova usar o outro —
 * mas o que existe hoje é `tarefaId`.
 */
function idDaTarefa(input: unknown): string | null {
  const dados = obj(input);
  return texto(dados.tarefaId) ?? texto(dados.taskId);
}

/**
 * O que o agente gerou para esta task.
 *
 * ⚠ **A chamada mais RECENTE vence.** Uma task pode ter sido reprocessada (o
 * próprio prompt manda voltar o status para Onboarding para tentar de novo), e
 * aí há mais de um documento. O último é o que vale — é o que está no
 * comentário mais novo e o que a equipe mandaria.
 *
 * Chamada com erro não conta: `isError` é filtrado por quem lê do banco.
 */
export function contratacaoDaTask(chamadas: Chamada[], taskId: string): Contratacao {
  const runs = execucoesDaTask(chamadas, taskId);
  if (!runs.size) return VAZIA;

  const daTask = chamadas
    .filter((c) => runs.has(c.runId))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const achado: Contratacao = { ...VAZIA };

  for (const c of daTask) {
    const saida = obj(c.output);

    // ⚠ `zapsign_ver_documento` conta tanto quanto `zapsign_gerar_contrato`, e
    // os dois devolvem a MESMA forma (`documentoId` + `signatarios`). Quando o
    // documento já existe — task reprocessada, ou o mesmo cliente voltando —, o
    // prompt manda não gerar outro, e o agente só CONSULTA. Sem esta linha o
    // acompanhamento ficava cego justamente aí: em 11/11/2026, no primeiro
    // teste limpo do Diego, a rodada achou contrato e cobrança e parou em
    // "aguardando o link de assinatura" com o link já existindo.
    if (c.toolName === "zapsign_gerar_contrato" || c.toolName === "zapsign_ver_documento") {
      const doc = texto(saida.documentoId);
      if (doc) {
        achado.documentoZapSign = doc;
        achado.linkAssinatura = linkDeAssinatura(saida) ?? achado.linkAssinatura;
      }
      continue;
    }

    if (c.toolName === "conexa_criar_contrato") {
      // Serve tanto o contrato criado agora quanto o `jaExistia`: nos dois o
      // campo é o mesmo, e nos dois existe contrato de verdade no ERP.
      const id = inteiro(saida.contratoId);
      if (id) achado.contratoConexa = id;
      const cliente = inteiro(obj(c.input).clienteId);
      if (cliente) achado.clienteConexa = cliente;
    }
  }

  return achado;
}

/**
 * O link de assinatura do documento.
 *
 * Fica em `signatarios[].linkParaAssinar`. ⚠ **Só vale com UM signatário.**
 * Com dois ou mais, cada um tem o seu link, e mandar o do primeiro ao cliente
 * poria a pessoa errada assinando — melhor não mandar nada e deixar a equipe
 * ver que falta link. Os contratos de EV e SeaBox saem com um signatário.
 */
export function linkDeAssinatura(saida: Record<string, unknown>): string | null {
  const signatarios = Array.isArray(saida.signatarios) ? saida.signatarios : [];
  if (signatarios.length !== 1) return null;
  return texto(obj(signatarios[0]).linkParaAssinar);
}

/*
 * ⚠ `cobrancaDoContrato` e `cobrancaPaga` MUDARAM DE CASA em 11/11/2026, para
 * `integrations/conexa/cobranca-do-contrato.ts`: deixaram de ser só da rodada
 * do acompanhamento quando `conexa_criar_contrato` passou a devolver o link de
 * pagamento do cliente. Dois donos, um lugar.
 */

/**
 * O documento está assinado?
 *
 * Vale o status do DOCUMENTO quando ele diz `signed`; senão, todos os
 * signatários com `assinou`. ⚠ Documento sem signatário nenhum não conta como
 * assinado — lista vazia faria `every` devolver verdadeiro.
 */
export function documentoAssinado(doc: {
  status?: string | null;
  signatarios?: Array<{ situacao?: string | null }> | null;
}) {
  if ((doc.status ?? "").trim().toLowerCase() === "signed") return true;
  const assinaturas = doc.signatarios ?? [];
  if (!assinaturas.length) return false;
  return assinaturas.every((s) => (s.situacao ?? "").trim().toLowerCase() === "assinou");
}

/**
 * O documento foi EXCLUÍDO na ZapSign?
 *
 * ⚠⚠ Existe porque excluir na ZapSign manda para a lixeira e **deixa o
 * `status` como estava** (`pending`): quem lê só o status acha que o contrato
 * continua de pé. `formatarDocumento` já resolve isso — devolve `excluido` —,
 * mas o acompanhamento não olhava, e o link do signatário continua vindo no
 * retorno, apontando para um documento que não existe mais.
 *
 * O risco é concreto e nasceu em 11/11/2026: a equipe apaga o documento para
 * refazer a contratação do zero, e entre a exclusão e a geração do novo a
 * rodada mandaria ao CLIENTE um link de assinatura morto. Sem link de
 * assinatura utilizável, a regra de "com UM link só não manda nada" segura a
 * mensagem, que é o desfecho certo: é melhor esperar do que mandar link que
 * não abre.
 */
export function documentoExcluido(doc: { status?: string | null }): boolean {
  return (doc.status ?? "").trim().toLowerCase() === "excluido";
}
