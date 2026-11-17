import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { IntegrationProvider, PesquisaNpsStatus } from "@/generated/prisma/enums";
import { telefoneCanonico } from "@/server/integrations/clickup/telefone";
import { agendarPesquisaNps } from "@/server/queue/nps";
import { lerConfigNps } from "./config";
import { ESPERA_DO_ENVIO_MS } from "./disparar";
import { motivoParaNaoIniciar } from "./regras";

const HORA = 3_600_000;

/** Etapas em que a pesquisa ainda age: as mesmas de `executar.ts`. */
const EM_ANDAMENTO: PesquisaNpsStatus[] = [
  PesquisaNpsStatus.AGENDADA,
  PesquisaNpsStatus.AGUARDANDO,
  PesquisaNpsStatus.LEMBRADA,
  PesquisaNpsStatus.RESPONDIDA,
  PesquisaNpsStatus.AGRADECIDA,
];

export type InicioDaPesquisa =
  | { iniciada: true; pesquisaId: string }
  | { iniciada: false; motivo: string };

/**
 * A pesquisa de satisfação no fim de um atendimento feito só pelo robô (pedido
 * do Régis em 17/11/2026: *"para atendimentos em que a automação atende o
 * cliente, ao fim do atendimento, o agente envie o NPS"*).
 *
 * Quem decide QUANDO é o agente: ele registra o prazo do cliente com acao
 * "pesquisa" depois de concluir o pedido, e o vigia chama isto no vencimento,
 * depois de conferir ao vivo que o cliente não escreveu e que ninguém da equipe
 * assumiu. Daqui em diante é a MESMA pesquisa do checkbox, gravada como
 * `AGENDADA`: o executor do NPS manda as três mensagens, lembra, recebe a nota
 * e resolve a conversa no fim. A diferença é o `agentId`, que diz de onde ela
 * veio e faz o executor não mexer no checkbox.
 *
 * Nunca lança: quem chama resolve a conversa quando a pesquisa não sai.
 */
export async function iniciarPesquisaAutomatica(args: {
  chatwootConversationId: number;
  inboxId: number | null;
  portaAgentId: string;
  agentId: string;
  /** Como veio do contato; vazio deixa o executor ler na hora de mandar. */
  telefone: string | null;
  agora?: number;
}): Promise<InicioDaPesquisa> {
  const agora = args.agora ?? Date.now();
  try {
    const integracao = await db.integration.findUnique({
      where: { provider: IntegrationProvider.NPS },
      select: { enabled: true, config: true },
    });
    const config = lerConfigNps(integracao?.config);
    const telefone = telefoneCanonico(args.telefone ?? "") || null;

    const [emAndamento, recente] = await Promise.all([
      db.pesquisaNps.findFirst({
        where: {
          chatwootConversationId: args.chatwootConversationId,
          status: { in: EM_ANDAMENTO },
        },
        select: { id: true },
      }),
      telefone && config.horasEntrePesquisas > 0
        ? db.pesquisaNps.findFirst({
            where: {
              telefone,
              enviadaEm: { gte: new Date(agora - config.horasEntrePesquisas * HORA) },
            },
            select: { chatwootConversationId: true },
          })
        : null,
    ]);

    const motivo = motivoParaNaoIniciar({
      ligada: integracao?.enabled ?? false,
      config,
      inboxId: args.inboxId,
      emAndamento: emAndamento != null,
      telefoneRecente: recente?.chatwootConversationId ?? null,
    });
    if (motivo) return { iniciada: false, motivo };

    const pesquisa = await db.pesquisaNps.create({
      data: {
        chatwootConversationId: args.chatwootConversationId,
        inboxId: args.inboxId,
        portaAgentId: args.portaAgentId,
        agentId: args.agentId,
        telefone,
        marcadaEm: new Date(agora),
        // A mesma espera do checkbox: a nota interna do prazo chega antes das
        // mensagens da pesquisa.
        venceEm: new Date(agora + ESPERA_DO_ENVIO_MS),
      },
      select: { id: true },
    });

    try {
      await agendarPesquisaNps(pesquisa.id, ESPERA_DO_ENVIO_MS);
    } catch (erro) {
      // Gravada já está: sem a fila, o vigia a manda no minuto seguinte.
      logger.warn({ erro, pesquisaId: pesquisa.id }, "NPS automático: sem fila — fica com o vigia");
    }
    return { iniciada: true, pesquisaId: pesquisa.id };
  } catch (erro) {
    const texto = erro instanceof Error ? erro.message : String(erro);
    logger.error(
      { erro: texto, conversa: args.chatwootConversationId },
      "NPS automático: não consegui registrar a pesquisa",
    );
    return { iniciada: false, motivo: `não consegui registrar a pesquisa (${texto})` };
  }
}
