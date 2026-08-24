import { z } from "zod";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition } from "../types";
import { chatwootConfigSchema } from "./config";
import { clienteDoAgente } from "./credenciais";
import { montarRoster, resolverDestino } from "@/server/agents/equipe";
import { resolverAtendente } from "./atendentes";
import { proximoDoRodizio } from "./rodizio";
import { entregarAoHumano } from "./resolucao";

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
  aviso: z
    .string()
    .min(5)
    .describe(
      "A mensagem que o CLIENTE vai ler antes de a conversa mudar de mãos. Natural, primeira pessoa. É a última coisa que você diz nesta conversa.",
    ),
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
        if (ctx.sinais) ctx.sinais.avisouCliente = true;

        await cliente.alternarStatus(conversa, "open");
        await cliente.atribuir(conversa, { assigneeId: achado.atendente.id });

        await entregarAoHumano(conversa, `atribuído a ${nome}: ${args.motivo}`);

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
      name: "atribuir_por_rodizio",
      categoria: "Atendimento",
      description:
        "Entrega o atendimento à próxima pessoa de um rodízio, alternando entre os nomes informados. Use quando o fluxo diz que a dupla ou o trio reveza os clientes. O sistema lembra quem recebeu por último. Depois de chamar, encerre o turno.",
      requiresConfirmation: true,
      inputSchema: z.object({
        rodizio: z
          .string()
          .min(2)
          .describe(
            'Nome do rodízio, sempre o mesmo para o mesmo grupo (ex.: "reservas"). É por ele que o sistema lembra a vez de quem é.',
          ),
        entre: z
          .array(z.string())
          .min(2)
          .describe("Nomes das pessoas que revezam, na ordem do revezamento."),
        motivo: z.string().min(3).describe("Fica em nota interna."),
        resumo: z
          .string()
          .min(10)
          .describe("O que o cliente quer e o que já foi coletado."),
        aviso: z
          .string()
          .min(5)
          .describe("A mensagem que o CLIENTE vai ler. Natural, primeira pessoa."),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          rodizio: string;
          entre: string[];
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

        const equipe = await cliente.listarAtendentes();

        // Todos os participantes têm de existir antes de girar o rodízio: girar
        // e só então descobrir que o sorteado não existe deixaria a vez perdida.
        const resolvidos = args.entre.map((nome) => ({
          nome,
          achado: resolverAtendente(nome, equipe),
        }));
        const problema = resolvidos.find((r) => r.achado.tipo !== "achado");
        if (problema) {
          return {
            erro: `"${problema.nome}" não está na equipe do Chatwoot — o rodízio não girou.`,
            atendentes: equipe.map((a) => a.name ?? a.email ?? String(a.id)),
          };
        }

        const chave = args.rodizio.trim().toLowerCase();

        // Trava a linha do rodízio: dois clientes escrevendo no mesmo instante
        // leriam o mesmo "último" e cairiam na mesma pessoa, que é justamente o
        // que o rodízio existe para evitar.
        const proximo = await db.$transaction(async (tx) => {
          await tx.rodizio.upsert({
            where: { nome: chave },
            create: { nome: chave },
            update: {},
          });

          const linhas = await tx.$queryRaw<{ ultimo: string | null }[]>`
            SELECT "ultimo" FROM "Rodizio" WHERE "nome" = ${chave} FOR UPDATE
          `;

          const escolhido = proximoDoRodizio(args.entre, linhas[0]?.ultimo);
          if (!escolhido) return null;

          await tx.rodizio.update({
            where: { nome: chave },
            data: { ultimo: escolhido },
          });
          return escolhido;
        });

        if (!proximo) return "Nenhum participante válido no rodízio.";

        const alvo = resolvidos.find((r) => r.nome === proximo)!.achado;
        if (alvo.tipo !== "achado") return "Não consegui resolver o sorteado.";

        const conversa = ctx.chatwootConversationId;
        const nome = alvo.atendente.name ?? proximo;

        await cliente.enviarMensagem(
          conversa,
          [
            `🤖 Rodízio "${chave}": a vez era de ${nome}. Motivo: ${args.motivo}`,
            `Resumo: ${args.resumo}`,
          ].join("\n"),
          { privado: true },
        );

        // Antes de atribuir, pelo mesmo motivo de atribuir_para_atendente.
        await cliente.enviarMensagem(conversa, args.aviso.trim());
        if (ctx.sinais) ctx.sinais.avisouCliente = true;

        await cliente.alternarStatus(conversa, "open");
        await cliente.atribuir(conversa, { assigneeId: alvo.atendente.id });

        await entregarAoHumano(
          conversa,
          `rodízio ${chave} → ${nome}: ${args.motivo}`,
        );

        logger.info({ conversa, rodizio: chave, atendente: nome }, "rodízio girou");

        return {
          atribuido: true,
          para: nome,
          observacao:
            "O cliente já foi avisado e a pessoa assumiu. Encerre o turno sem escrever mais nada.",
        };
      },
    },


    {
      name: "registrar_nota_interna",
      categoria: "Atendimento",
      description:
        "Escreve uma nota INTERNA na conversa: só a equipe lê, o cliente não. Use para registrar o que você conferiu e por quê — o que bateu, o que divergiu, o que ficou em dúvida. É o que permite uma pessoa discordar de você depois. Não use para falar com o cliente.",
      inputSchema: z.object({
        texto: z
          .string()
          .min(5)
          .describe(
            "O registro, em uma ou poucas frases. Diga o que foi conferido e o resultado, não só o veredito.",
          ),
      }),
      async execute(entrada, ctx) {
        const { texto } = entrada as { texto: string };

        if (!ctx.chatwootConversationId) {
          return "Sem conversa do Chatwoot neste contexto — não há onde registrar.";
        }

        const cliente = await clienteDoAgente(ctx.canalAgentId ?? ctx.agentId);
        if (!cliente) {
          throw new Error("Bot do Chatwoot não configurado para o canal desta conversa.");
        }

        await cliente.enviarMensagem(ctx.chatwootConversationId, texto.trim(), {
          privado: true,
        });

        return { registrado: true, observacao: "Nota interna gravada. O cliente não vê." };
      },
    },

    {
      name: "ver_dados_do_contato",
      categoria: "Cliente",
      description:
        "Mostra o cadastro do contato desta conversa no Chatwoot: nome, e-mail, telefone e os atributos personalizados já anotados (por exemplo, se o documento dele já foi conferido antes). Consulte ANTES de pedir dado ao cliente — pode ser que já esteja registrado.",
      inputSchema: z.object({}),
      async execute(_entrada, ctx) {
        if (!ctx.chatwootConversationId) {
          return "Sem conversa do Chatwoot neste contexto — não há contato para consultar.";
        }

        const cliente = await clienteDoAgente(ctx.canalAgentId ?? ctx.agentId);
        if (!cliente) {
          throw new Error("Bot do Chatwoot não configurado para o canal desta conversa.");
        }

        const conversa = await cliente.obterConversa(ctx.chatwootConversationId);
        if (!conversa.contactId) {
          return "A conversa não trouxe o contato — não dá para consultar o cadastro.";
        }

        const contato = await cliente.obterContato(conversa.contactId);
        return {
          nome: contato.nome,
          email: contato.email,
          telefone: contato.telefone,
          atributos: contato.atributos,
        };
      },
    },

    {
      name: "anotar_no_contato",
      categoria: "Cliente",
      requiresConfirmation: true,
      description:
        "Grava informação no cadastro do CONTATO (a pessoa), não na conversa. Use para o que precisa sobreviver ao fim do atendimento: resultado de conferência de documento, validade, data. A conversa é encerrada e some da vista; o contato permanece, e no próximo atendimento a informação ainda está lá. Para observação que só vale para este atendimento, use registrar_nota_interna.",
      inputSchema: z.object({
        atributos: z
          .array(
            z.object({
              chave: z
                .string()
                .min(1)
                .describe(
                  "Identificador do campo, minúsculo e sem espaço (ex.: cnh_status). Precisa existir em Configurações → Atributos personalizados do Chatwoot para aparecer bonito na tela.",
                ),
              valor: z
                .string()
                .describe("O valor a gravar. Texto vazio APAGA o atributo."),
            }),
          )
          .min(1)
          .describe("Um ou mais campos para gravar de uma vez."),
      }),
      async execute(entrada, ctx) {
        const { atributos } = entrada as {
          atributos: { chave: string; valor: string }[];
        };

        if (!ctx.chatwootConversationId) {
          return "Sem conversa do Chatwoot neste contexto — não há contato para anotar.";
        }

        const cliente = await clienteDoAgente(ctx.canalAgentId ?? ctx.agentId);
        if (!cliente) {
          throw new Error("Bot do Chatwoot não configurado para o canal desta conversa.");
        }

        const conversa = await cliente.obterConversa(ctx.chatwootConversationId);
        if (!conversa.contactId) {
          return "A conversa não trouxe o contato — não dá para anotar no cadastro.";
        }

        // Texto vazio vira `null`, que é como o cliente apaga a chave sem
        // apagar as outras.
        const mapa = Object.fromEntries(
          atributos.map((a) => [
            a.chave.trim(),
            a.valor.trim() === "" ? null : a.valor.trim(),
          ]),
        );

        const gravados = await cliente.definirAtributosDoContato(
          conversa.contactId,
          mapa,
        );

        logger.info(
          { conversa: ctx.chatwootConversationId, chaves: Object.keys(mapa) },
          "atributos do contato atualizados pelo agente",
        );

        return { anotado: true, atributosDoContato: gravados };
      },
    },

    {
      name: "transferir_para_humano",
      description:
        "Passa o atendimento para uma pessoa da equipe. Use quando não souber responder com certeza, quando o cliente pedir, ou em assunto sensível (cobrança, cancelamento, reclamação). Depois de chamar, não continue respondendo.",
      inputSchema: transferirSchema,
      requiresConfirmation: false,
      async execute(entrada, ctx) {
        const { motivo, resumo, aviso } = entrada as z.infer<
          typeof transferirSchema
        >;

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
          select: {
            handoffEnabled: true,
            handoffTeamId: true,
            fallbackAtendente: true,
          },
        });

        if (!agente.handoffEnabled) {
          return "A transferência está desabilitada para este agente. Continue o atendimento.";
        }

        const conversa = ctx.chatwootConversationId;

        // Quem assume. "Passar para a equipe" sem ninguém atribuído deixava a
        // conversa órfã: status humano, dono nenhum, e o vigia não olha para
        // ela porque só vigia conversa do bot. Ninguém estava a caminho.
        let assigneeId: number | undefined;
        let dono: string | null = null;

        if (agente.fallbackAtendente) {
          const achado = resolverAtendente(
            agente.fallbackAtendente,
            await cliente.listarAtendentes(),
          );
          if (achado.tipo === "achado") {
            assigneeId = achado.atendente.id;
            dono = achado.atendente.name ?? agente.fallbackAtendente;
          } else {
            logger.warn(
              { conversa, alvo: agente.fallbackAtendente },
              "responsável padrão do agente não existe no Chatwoot",
            );
          }
        }

        const semDono = !assigneeId && !agente.handoffTeamId;

        // Nota interna primeiro: se algo falhar depois, a equipe já tem o contexto.
        await cliente.enviarMensagem(
          conversa,
          [
            `🤖 Transferido pelo agente. Motivo: ${motivo}`,
            resumo && `Resumo: ${resumo}`,
            dono && `Atribuído a ${dono}.`,
            // Uma conversa sem dono some no meio da fila. Melhor a equipe
            // saber disso pela nota do que descobrir pelo cliente cobrando.
            semDono &&
              "⚠️ Ninguém foi atribuído: este agente não tem responsável padrão configurado no painel. A conversa fica na fila.",
          ]
            .filter(Boolean)
            .join("\n"),
          { privado: true },
        );

        // O aviso vai ANTES de atribuir: com `assignee_id` preenchido a regra
        // global cala o bot, e a mensagem ao cliente seria descartada.
        await cliente.enviarMensagem(conversa, aviso.trim());
        if (ctx.sinais) ctx.sinais.avisouCliente = true;

        await cliente.alternarStatus(conversa, "open");

        if (assigneeId || agente.handoffTeamId) {
          await cliente.atribuir(conversa, {
            ...(assigneeId ? { assigneeId } : {}),
            ...(agente.handoffTeamId ? { teamId: agente.handoffTeamId } : {}),
          });
        }

        // Acrescenta, não substitui: apagar os labels da conversa apagaria o
        // critério que outro bot na mesma caixa usa para saber se é a vez dele.
        await cliente.adicionarLabel(conversa, "transferido-pelo-bot");

        // Cala o bot nesta conversa até alguém devolver para `pending`.
        await entregarAoHumano(conversa, motivo);

        logger.info({ conversa, motivo, dono }, "conversa transferida para humano");

        return dono
          ? `Transferido para ${dono} e o cliente já foi avisado. Encerre o turno sem escrever mais nada.`
          : "Transferido para a fila da equipe e o cliente já foi avisado. Encerre o turno sem escrever mais nada.";
      },
    },
  ],
};
