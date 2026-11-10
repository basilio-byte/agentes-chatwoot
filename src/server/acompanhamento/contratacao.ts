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
    if (texto(obj(c.input).taskId) === taskId) runs.add(c.runId);
  }
  return runs;
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

    if (c.toolName === "zapsign_gerar_contrato") {
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

/**
 * A cobrança daquele contrato, entre as do cliente.
 *
 * ⚠ **O vínculo é cobrança → venda → contrato**, e não "a mais recente do
 * cliente": um cliente que contrata um segundo produto tem duas cobranças
 * contratuais abertas ao mesmo tempo, e mandar a do outro produto seria cobrar
 * o valor errado. É o mesmo caminho que as notas fiscais usam.
 */
export function cobrancaDoContrato(
  cobrancas: Array<{ id: number | null; status: string | null; faturaUrl: string | null; vendas: number[] }>,
  vendasDoContrato: ReadonlySet<number>,
) {
  const daqui = cobrancas.filter((c) => c.vendas.some((v) => vendasDoContrato.has(v)));
  // A mais antiga é a primeira do contrato — é a que o cliente precisa pagar
  // para a contratação começar.
  return daqui.sort((a, b) => (a.id ?? 0) - (b.id ?? 0))[0] ?? null;
}

/** O Conexa chama de `paid` a cobrança quitada. Pago em parte não é pago. */
export function cobrancaPaga(status: string | null | undefined) {
  return (status ?? "").trim().toLowerCase() === "paid";
}

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
