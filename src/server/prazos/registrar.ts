import { db } from "@/lib/db";
import { PrazoStatus, PrazoTipo } from "@/generated/prisma/enums";
import { MOTIVO, type AcaoDoPrazo } from "./decisao";

/**
 * Grava um prazo novo, substituindo o pendente do mesmo tipo na conversa.
 *
 * Um só pendente por conversa e tipo — quem garante é o índice parcial
 * `PrazoDeConversa_um_pendente` no banco; o `updateMany` aqui é o que dá
 * significado à substituição. É ela que faz "zerar a cada resposta": o agente
 * registra o prazo de novo a cada pergunta, e o anterior cai.
 */
export async function registrarPrazo(args: {
  tipo: PrazoTipo;
  chatwootConversationId: number;
  agentId: string;
  portaAgentId: string;
  minutos: number;
  referenciaMensagemId: number;
  donoId: number | null;
  donoNome: string | null;
  acao: AcaoDoPrazo;
  motivo: string;
  agora?: number;
}) {
  const agora = args.agora ?? Date.now();

  return db.$transaction(async (tx) => {
    await tx.prazoDeConversa.updateMany({
      where: {
        chatwootConversationId: args.chatwootConversationId,
        tipo: args.tipo,
        status: PrazoStatus.PENDENTE,
      },
      data: {
        status: PrazoStatus.CANCELADO,
        resultado: MOTIVO.substituido,
        finalizadoEm: new Date(agora),
      },
    });

    return tx.prazoDeConversa.create({
      data: {
        tipo: args.tipo,
        chatwootConversationId: args.chatwootConversationId,
        agentId: args.agentId,
        portaAgentId: args.portaAgentId,
        minutos: args.minutos,
        venceEm: new Date(agora + args.minutos * 60_000),
        referenciaMensagemId: args.referenciaMensagemId,
        donoId: args.donoId,
        donoNome: args.donoNome,
        acao: JSON.parse(JSON.stringify(args.acao)),
        motivo: args.motivo,
      },
    });
  });
}

/**
 * A conversa já voltou para o agente neste atendimento?
 *
 * Uma volta só. A segunda viraria pingue-pongue: o agente entrega de novo, o
 * prazo devolve de novo, e o cliente fica indo e vindo sem ninguém fechar a
 * venda. "Neste atendimento" é depois do último corte do histórico — resolver e
 * reabrir começa outro.
 */
export async function jaVoltouParaOAgente(
  chatwootConversationId: number,
): Promise<boolean> {
  const conversa = await db.conversation.findUnique({
    where: { chatwootConversationId },
    select: { historicoDesde: true },
  });

  const executados = await db.prazoDeConversa.findMany({
    where: {
      chatwootConversationId,
      tipo: PrazoTipo.EQUIPE,
      status: PrazoStatus.EXECUTADO,
      ...(conversa?.historicoDesde
        ? { finalizadoEm: { gte: conversa.historicoDesde } }
        : {}),
    },
    select: { acao: true },
  });

  return executados.some(
    (p) => (p.acao as { tipo?: unknown } | null)?.tipo === "voltar_para_o_agente",
  );
}
