import { z } from "zod";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ConversationStatus, IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition } from "../types";
import { chatwootConfigSchema } from "./config";
import { clienteDoAgente } from "./credenciais";
import { montarRoster, resolverDestino } from "@/server/agents/equipe";
import { resolverAtendente } from "./atendentes";

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
      name: "transferir_para_agente",
      categoria: "Atendimento",
      description:
        "Passa o atendimento para outro agente da equipe, listado em 'COLEGAS PARA QUEM VOCÊ PODE TRANSFERIR'. Quem recebe assume por inteiro e continua na hora. Use quando o assunto for da especialidade de um colega. Depois de chamar, encerre o turno — quem fala com o cliente a partir daí é ele.",
      inputSchema: z.object({
        destino: z
          .string()
          .describe("A chave do colega, exatamente como está na lista."),
        motivo: z
          .string()
          .min(3)
          .describe("Por que está passando, em uma frase. Fica em nota interna."),
        resumo: z
          .string()
          .min(10)
          .describe(
            "O que o cliente quer, o que já foi coletado e o que falta. É só isto que o colega recebe — ele não vê o que você pensou.",
          ),
        aviso: z
          .string()
          .min(5)
          .describe(
            "A mensagem que o CLIENTE vai ler avisando da passagem. Escreva natural, na primeira pessoa (ex.: 'Vou te passar para quem cuida de reservas, um instante').",
          ),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          destino: string;
          motivo: string;
          resumo: string;
          aviso: string;
        };

        if (!ctx.chatwootConversationId) {
          return "Sem conversa do Chatwoot neste contexto — não há atendimento para transferir.";
        }
        if (!ctx.sinais) {
          return "Transferência entre agentes não está disponível nesta execução.";
        }

        const equipe = await db.agent.findMany({
          // Arquivado não entra na equipe: não roteia, não recebe transferência e
          // não aparece no prompt de ninguém.
          where: { archivedAt: null },
          select: {
            id: true,
            key: true,
            name: true,
            routingDescription: true,
            active: true,
            isEntry: true,
          },
        });

        const roster = montarRoster(equipe, ctx.agentId);
        const achado = resolverDestino(args.destino, roster);

        if (achado.tipo === "nenhum") {
          // Devolve as chaves válidas em vez de só falhar: o modelo corrige e
          // chama de novo no mesmo turno, sem perder a transferência.
          return {
            erro: `"${args.destino}" não é um colega disponível.`,
            chavesValidas: achado.chavesValidas,
          };
        }

        ctx.sinais.handoff = {
          destinoId: achado.destino.id,
          destinoKey: achado.destino.key,
          destinoNome: achado.destino.name,
          motivo: args.motivo,
          resumo: args.resumo,
          aviso: args.aviso,
        };

        return {
          transferido: true,
          para: achado.destino.name,
          observacao:
            "O cliente será avisado e o colega assume agora. Encerre seu turno.",
        };
      },
    },

    {
      name: "listar_atendentes",
      categoria: "Atendimento",
      description:
        "Lista as pessoas da equipe no Chatwoot, com nome e disponibilidade. Use antes de atribuir a alguém específico, quando não souber quem existe ou quiser saber quem está online.",
      inputSchema: z.object({}),
      async execute(_entrada, ctx) {
        const cliente = await clienteDoAgente(ctx.canalAgentId ?? ctx.agentId);
        if (!cliente) {
          throw new Error("Bot do Chatwoot não configurado para o canal desta conversa.");
        }

        const atendentes = await cliente.listarAtendentes();
        return atendentes.map((a) => ({
          nome: a.name ?? a.email ?? String(a.id),
          email: a.email ?? null,
          disponivel: a.availability_status === "online",
        }));
      },
    },

    {
      name: "atribuir_para_atendente",
      categoria: "Atendimento",
      description:
        "Entrega o atendimento a uma PESSOA específica da equipe, pelo nome. A partir daí quem responde é ela — a IA para nesta conversa. Use quando o fluxo define um responsável fixo. Se qualquer pessoa da equipe serve, use transferir_para_humano. Depois de chamar, encerre o turno.",
      requiresConfirmation: true,
      inputSchema: z.object({
        atendente: z
          .string()
          .describe(
            "Nome da pessoa, como está no Chatwoot. Primeiro nome basta se não houver xará.",
          ),
        motivo: z
          .string()
          .min(3)
          .describe("Por que está entregando para ela. Fica em nota interna."),
        resumo: z
          .string()
          .min(10)
          .describe(
            "O que o cliente quer e o que já foi coletado. É o que a pessoa lê antes de assumir.",
          ),
        aviso: z
          .string()
          .min(5)
          .describe(
            "A mensagem que o CLIENTE vai ler. Escreva natural, na primeira pessoa.",
          ),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          atendente: string;
          motivo: string;
          resumo: string;
          aviso: string;
        };

        if (!ctx.chatwootConversationId) {
          return "Sem conversa do Chatwoot neste contexto — não há atendimento para atribuir.";
        }

        const cliente = await clienteDoAgente(ctx.canalAgentId ?? ctx.agentId);
        if (!cliente) {
          throw new Error("Bot do Chatwoot não configurado para o canal desta conversa.");
        }

        const achado = resolverAtendente(
          args.atendente,
          await cliente.listarAtendentes(),
        );

        if (achado.tipo === "nenhum") {
          return {
            erro: `Não achei "${args.atendente}" na equipe.`,
            atendentes: achado.disponiveis,
          };
        }
        if (achado.tipo === "ambiguo") {
          return {
            erro: `"${args.atendente}" corresponde a mais de uma pessoa. Use o nome completo.`,
            candidatos: achado.candidatos,
          };
        }

        const conversa = ctx.chatwootConversationId;
        const nome = achado.atendente.name ?? args.atendente;

        // Nota interna primeiro: se algo falhar depois, quem assumir já tem o
        // contexto na conversa.
        await cliente.enviarMensagem(
          conversa,
          [
            `🤖 Atribuído a ${nome} pelo agente. Motivo: ${args.motivo}`,
            `Resumo: ${args.resumo}`,
          ].join("\n"),
          { privado: true },
        );

        // O aviso sai ANTES da atribuição, e daqui e não do worker: atribuir a
        // uma pessoa preenche `assignee_id`, e a partir daí a regra global
        // manda o agente calar — o texto final do turno seria descartado e o
        // cliente veria a conversa mudar de mãos sem uma palavra.
        await cliente.enviarMensagem(conversa, args.aviso.trim());

        await cliente.alternarStatus(conversa, "open");
        await cliente.atribuir(conversa, { assigneeId: achado.atendente.id });

        await db.conversation.updateMany({
          where: { chatwootConversationId: conversa },
          data: {
            status: ConversationStatus.HUMAN,
            handoffReason: `atribuído a ${nome}: ${args.motivo}`,
            handoffAt: new Date(),
          },
        });

        logger.info({ conversa, atendente: nome }, "conversa atribuída a pessoa");

        return {
          atribuido: true,
          para: nome,
          observacao:
            "O cliente já foi avisado e a pessoa assumiu. Encerre o turno sem escrever mais nada.",
        };
      },
    },

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

        // Bot da PORTA, não do agente atual: quem assumiu por transferência
        // costuma não ter bot próprio, e a escalada para humano não pode falhar
        // justamente por isso.
        const cliente = await clienteDoAgente(ctx.canalAgentId ?? ctx.agentId);
        if (!cliente) {
          throw new Error("Bot do Chatwoot não configurado para o canal desta conversa.");
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
