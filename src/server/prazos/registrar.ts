import { db } from "@/lib/db";
import { PrazoStatus, type PrazoTipo } from "@/generated/prisma/enums";
import type { AcaoDoPrazo } from "./decisao";

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
        resultado: "substituído por um prazo novo",
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
