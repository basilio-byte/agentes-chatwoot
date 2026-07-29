import { z } from "zod";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ConversationStatus, IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition } from "../types";
import { chatwootConfigSchema } from "./config";
import { clienteDoAgente } from "./credenciais";

const transferirSchema = z.object({
  motivo: z
    .string()
    .min(3)
    .describe(
      "Por que está transferindo, em uma frase. Aparece como nota interna para a equipe.",
    ),
  resumo: z
    .string()
    .optional()
    .describe("Resumo do que o cliente já contou, para o humano não repetir perguntas."),
});

/**
 * Integração do Chatwoot.
 *
 * Diferente das outras: a credencial não fica em `IntegrationCredential`, e sim
 * em `AgentChatwootBot` — um bot por agente. Por isso a tool resolve o cliente
 * pelo `agentId` do contexto em vez de usar `ctx.credential`.
 */
export const chatwootIntegration: IntegrationDefinition = {
  provider: IntegrationProvider.CHATWOOT,
  label: "Chatwoot",
  descricao:
    "Canal de atendimento. Cada agente responde como o Agent Bot dele nas inboxes vinculadas.",
  configSchema: chatwootConfigSchema,
  credentialLabel: null, // por agente, não pela integração

  async testarConexao(ctx) {
    const cliente = await clienteDoAgente(ctx.agentId);
    if (!cliente) {
      return { ok: false, mensagem: "Bot do agente não configurado." };
    }
    return cliente.testar();
  },

  tools: [
    {
      name: "transferir_para_humano",
      description:
        "Passa o atendimento para uma pessoa da equipe. Use quando não souber responder com certeza, quando o cliente pedir, ou em assunto sensível (cobrança, cancelamento, reclamação). Depois de chamar, não continue respondendo.",
      inputSchema: transferirSchema,
      requiresConfirmation: false,
      async execute(entrada, ctx) {
        const { motivo, resumo } = entrada as z.infer<typeof transferirSchema>;

        if (!ctx.chatwootConversationId) {
          return "Sem conversa do Chatwoot neste contexto — nada a transferir.";
        }

        const cliente = await clienteDoAgente(ctx.agentId);
        if (!cliente) {
          throw new Error("Bot do Chatwoot não configurado para este agente.");
        }

        const agente = await db.agent.findUniqueOrThrow({
          where: { id: ctx.agentId },
          select: { handoffEnabled: true, handoffTeamId: true },
        });

        if (!agente.handoffEnabled) {
          return "A transferência está desabilitada para este agente. Continue o atendimento.";
        }

        const conversa = ctx.chatwootConversationId;

        // Nota interna primeiro: se algo falhar depois, a equipe já tem o contexto.
        await cliente.enviarMensagem(
          conversa,
          [`🤖 Transferido pelo agente. Motivo: ${motivo}`, resumo && `Resumo: ${resumo}`]
            .filter(Boolean)
            .join("\n"),
          { privado: true },
        );

        await cliente.alternarStatus(conversa, "open");

        if (agente.handoffTeamId) {
          await cliente.atribuir(conversa, { teamId: agente.handoffTeamId });
        }

        // Acrescenta, não substitui: apagar os labels da conversa apagaria o
        // critério que outro bot na mesma caixa usa para saber se é a vez dele.
        await cliente.adicionarLabel(conversa, "transferido-pelo-bot");

        // Cala o bot nesta conversa até alguém devolver para `pending`.
        await db.conversation.updateMany({
          where: { chatwootConversationId: conversa },
          data: {
            status: ConversationStatus.HUMAN,
            handoffReason: motivo,
            handoffAt: new Date(),
          },
        });

        logger.info({ conversa, motivo }, "conversa transferida para humano");

        return "Transferido. Avise o cliente que alguém da equipe vai continuar o atendimento e encerre sua resposta.";
      },
    },
  ],
};
