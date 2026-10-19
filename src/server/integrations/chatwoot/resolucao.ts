import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { CaminhoDoRepasse, ConversationStatus } from "@/generated/prisma/enums";
import { eventoChatwootSchema } from "./eventos";
import { ehResolvida } from "./regras";

/**
 * Marca a conversa como encerrada e corta o histórico.
 *
 * O corte é o coração da regra: o mesmo cliente costuma voltar por outro
 * assunto, e arrastar o contexto anterior faria o agente responder a pergunta
 * errada. Reabriu, começa do zero.
 *
 * Zera junto o dono e o bastão. Sem isso, uma conversa reaberta voltaria direto
 * para o especialista do atendimento passado — que é justamente o contexto que
 * a regra manda esquecer.
 *
 * Mora fora do worker de propósito: as rotas de webhook precisam dela, e
 * importar o worker traria o BullMQ inteiro para dentro do processo web.
 */
export async function marcarResolvida(chatwootConversationId: number) {
  const agora = new Date();
  await db.conversation.updateMany({
    where: { chatwootConversationId },
    data: {
      status: ConversationStatus.CLOSED,
      resolvidaEm: agora,
      historicoDesde: agora,
      agentId: null,
      // Ninguém mais está esperando. Sem zerar, o relógio antigo sobreviveria
      // à reabertura e o vigia escalaria a conversa nova no primeiro minuto.
      aguardandoDesde: null,
      handoffParaAgentId: null,
      handoffResumo: null,
      handoffMotivo: null,
      handoffDeNome: null,
      // A volta ao agente vale para ESTE atendimento: reabriu, começa do zero.
      retomadaEm: null,
      retomadaPendente: false,
    },
  });
}

/**
 * Passa a conversa para uma pessoa. **Única porta** para esse estado.
 *
 * Existia espalhada por seis lugares — as três tools de atribuição, a trava do
 * laço, o vigia e o webhook de conta — todas repetindo a mesma tripa de campos.
 * O dia em que alguém adicionasse um campo novo, seis lugares precisariam
 * lembrar; foi exatamente o que aconteceu com `aguardandoDesde`, e o resultado
 * era o vigia reescalando conversa que já estava com um humano.
 */
export async function entregarAoHumano(
  chatwootConversationId: number,
  motivo: string,
  /** Por onde a conversa chegou à pessoa; nulo quando não é repasse a ninguém
   * (a regra global vê a conversa adiada, por exemplo). */
  caminho: CaminhoDoRepasse | null,
) {
  // Lida ANTES de gravar: é o estado anterior que diz se houve repasse.
  const antes = caminho ? await conversasAntesDoRepasse(chatwootConversationId) : [];

  await db.conversation.updateMany({
    where: { chatwootConversationId },
    data: {
      status: ConversationStatus.HUMAN,
      handoffReason: motivo,
      handoffAt: new Date(),
      // Daqui em diante quem deve resposta é uma pessoa, e o vigia não cobra
      // pessoa. Sem zerar, ele escalaria de novo o que já foi escalado.
      aguardandoDesde: null,
      // Nem o turno de retomada: com gente dona da conversa, ele não roda mais.
      retomadaPendente: false,
    },
  });

  if (caminho) await registrarRepasse(chatwootConversationId, caminho, antes);
}

/**
 * Se a passagem para uma pessoa vira um evento do histórico de repasses
 * (`RepasseParaPessoa`, lido pelo contrato de métricas).
 *
 * Conversa que já estava com uma pessoa não conta de novo: o webhook de conta
 * reafirma "uma pessoa assumiu" a cada atualização, e cada uma viraria um
 * repasse. A exceção é o prazo vencido, que passa de uma pessoa para OUTRA.
 */
export function contaComoRepasse(
  statusAntes: ConversationStatus,
  caminho: CaminhoDoRepasse,
): boolean {
  return statusAntes !== ConversationStatus.HUMAN || caminho === CaminhoDoRepasse.PRAZO_VENCIDO;
}

type EstadoAntes = { id: string; status: ConversationStatus; agentId: string | null };

async function conversasAntesDoRepasse(chatwootConversationId: number): Promise<EstadoAntes[]> {
  try {
    return await db.conversation.findMany({
      where: { chatwootConversationId },
      select: { id: true, status: true, agentId: true },
    });
  } catch (err) {
    logger.warn({ err, chatwootConversationId }, "repasse: não li a conversa antes de entregar");
    return [];
  }
}

/**
 * Grava o evento. Nunca lança: o histórico é métrica, e a entrega da conversa a
 * uma pessoa não pode falhar por causa dele. Duas entregas no mesmo instante
 * podem gerar dois eventos (a leitura e a gravação não são atômicas) — aceito.
 */
async function registrarRepasse(
  chatwootConversationId: number,
  caminho: CaminhoDoRepasse,
  antes: EstadoAntes[],
) {
  const repasses = antes.filter((c) => contaComoRepasse(c.status, caminho));
  if (repasses.length === 0) return;
  try {
    await db.repasseParaPessoa.createMany({
      data: repasses.map((c) => ({
        conversationId: c.id,
        chatwootConversationId,
        agentId: c.agentId,
        caminho,
      })),
    });
  } catch (err) {
    logger.warn({ err, chatwootConversationId, caminho }, "repasse: evento não gravado");
  }
}

/**
 * Devolve a conversa ao agente que registrou o prazo da equipe. **Única porta**
 * para esse estado, como `entregarAoHumano` é para o oposto.
 *
 * O bastão passa a dizer para quem a conversa voltou e por quê, e a retomada
 * pendente é o que faz o worker rodar o agente sem mensagem nova do cliente. O
 * relógio da espera acende, porque o cliente está esperando: se o turno não
 * sair, o vigia enxerga esta conversa como enxerga qualquer outra sem resposta.
 *
 * Devolve quantas linhas mudaram. Zero é conversa que não existe no nosso banco,
 * e quem chama não pode seguir como se tivesse devolvido.
 */
export async function devolverAoAgente(
  chatwootConversationId: number,
  volta: { agentId: string; deNome: string | null; motivo: string },
): Promise<number> {
  const agora = new Date();
  const { count } = await db.conversation.updateMany({
    where: { chatwootConversationId },
    data: {
      status: ConversationStatus.BOT,
      agentId: volta.agentId,
      handoffParaAgentId: volta.agentId,
      handoffDeNome: volta.deNome,
      handoffMotivo: volta.motivo,
      handoffResumo: null,
      retomadaEm: agora,
      retomadaPendente: true,
      aguardandoDesde: agora,
    },
  });
  return count;
}

/**
 * De onde sai o id e o status da conversa — que **muda conforme o evento**.
 *
 * Em `message_created` o payload é a mensagem, e a conversa vem aninhada em
 * `conversation`. Em `conversation_status_changed` e `conversation_updated` o
 * payload **é a própria conversa**: o id está no topo, em `id`, e não existe
 * `conversation` nenhum.
 *
 * Olhar só o lugar aninhado fazia a resolução passar batido — o evento chegava,
 * era registrado, e saía sem fazer nada (constatado em produção, 2026-07-31).
 * Aceitar as duas formas é o que torna isto confiável.
 */
export function lerConversa(evento: {
  event: string;
  id?: number | string;
  status?: string;
  conversation?: { id?: number; status?: string };
}): { conversationId?: number; status?: string } {
  if (evento.conversation?.id) {
    return {
      conversationId: evento.conversation.id,
      status: evento.conversation.status ?? evento.status,
    };
  }

  // Sem conversa aninhada: só faz sentido tratar o topo como conversa quando o
  // evento é de conversa. Em `message_created`, o `id` do topo é da MENSAGEM —
  // usá-lo apontaria para a conversa errada.
  if (!evento.event.startsWith("conversation_")) return {};

  const id = Number(evento.id);
  return {
    conversationId: Number.isInteger(id) && id > 0 ? id : undefined,
    status: evento.status ?? evento.conversation?.status,
  };
}

/**
 * Detecta, em qualquer entrega de webhook, que a conversa foi resolvida.
 *
 * Vale para o webhook **de bot** também, e não só para o de conta: na prática o
 * Agent Bot recebe `conversation_updated` (visto em produção, 2026-07-31), e
 * nós descartávamos esse evento. O resultado era uma conversa resolvida no
 * Chatwoot que continuava atribuída ao agente aqui, com o histórico intacto —
 * até alguém escrever nela de novo.
 *
 * Devolve `true` quando de fato marcou, para quem chama registrar o desfecho.
 */
export async function sincronizarResolucao(
  payload: unknown,
): Promise<{ resolvida: boolean; conversationId?: number }> {
  const parsed = eventoChatwootSchema.safeParse(payload);
  if (!parsed.success) return { resolvida: false };

  const evento = parsed.data;

  // Mensagem NÃO é sinal de resolução. Em `message_created` o status da
  // conversa é só contexto, e vem "resolved" quando o cliente escreve numa
  // conversa encerrada — exatamente o caso em que ela está voltando à vida.
  // Tratar isso como resolução engolia a mensagem: a rota registrava
  // "conversa zerada" e devolvia 200 sem enfileirar nada.
  //
  // Quem resolve avisa por evento de conversa, e é de lá que a resolução vem.
  if (evento.event === "message_created") return { resolvida: false };

  const { conversationId, status } = lerConversa(evento);

  if (!conversationId || !ehResolvida(status)) return { resolvida: false };

  // Conversa que nunca passou por um agente nosso não tem o que sincronizar.
  const conhecida = await db.conversation.findUnique({
    where: { chatwootConversationId: conversationId },
    select: { id: true, status: true },
  });
  if (!conhecida) return { resolvida: false };
  if (conhecida.status === ConversationStatus.CLOSED) {
    return { resolvida: false, conversationId };
  }

  await marcarResolvida(conversationId);
  logger.info(
    { conversa: conversationId },
    "conversa resolvida — dono liberado e histórico cortado",
  );

  return { resolvida: true, conversationId };
}
