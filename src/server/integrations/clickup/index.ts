import { z } from "zod";
import { IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition, ToolContext } from "../types";
import { clickupConfigSchema, type ClickUpConfig } from "./config";
import { ClickUpClient } from "./client";
import {
  filtrarPorTexto,
  formatarTarefa,
  formatarTarefaDetalhada,
  paraTimestamp,
  resolverMembro,
} from "./formatacao";
import { PRIORIDADES, type ClickUpUsuario } from "./tipos";

/** Teto por resposta: lista longa demais só gasta token sem ajudar o modelo. */
const LIMITE_RESULTADOS = 25;

function contexto(ctx: ToolContext): {
  cliente: ClickUpClient;
  config: ClickUpConfig;
} {
  if (!ctx.credential) {
    throw new Error("Token do ClickUp não configurado.");
  }
  const config = clickupConfigSchema.parse(ctx.config);
  return { cliente: new ClickUpClient(ctx.credential), config };
}

async function membrosDoWorkspace(
  cliente: ClickUpClient,
  teamId: string,
): Promise<ClickUpUsuario[]> {
  const { teams } = await cliente.listarWorkspaces();
  const workspace = teams.find((t) => t.id === teamId) ?? teams[0];
  return (workspace?.members ?? []).map((m) => m.user);
}

const prioridadeSchema = z
  .enum(["urgente", "alta", "normal", "baixa"])
  .describe("Prioridade da tarefa.");

export const clickupIntegration: IntegrationDefinition = {
  provider: IntegrationProvider.CLICKUP,
  label: "ClickUp",
  descricao:
    "Consulta e administração de tarefas: criar, atualizar status, comentar e atribuir responsáveis.",
  configSchema: clickupConfigSchema,
  credentialLabel: "Token pessoal da API (pk_...)",

  async testarConexao(ctx) {
    const { cliente } = contexto(ctx);
    return cliente.testar();
  },

  tools: [
    // --- leitura ----------------------------------------------------------
    {
      name: "clickup_listar_estrutura",
      description:
        "Lista os espaços, pastas e listas do ClickUp, com os status válidos de cada lista. Chame antes de criar uma tarefa quando não souber em qual lista ela deve entrar, ou antes de mudar status, para saber os nomes aceitos.",
      inputSchema: z.object({}),
      async execute(_entrada, ctx) {
        const { cliente, config } = contexto(ctx);
        const { spaces } = await cliente.listarSpaces(config.teamId);

        const permitidos = config.spaceIdsPermitidos ?? [];
        const visiveis = spaces.filter(
          (s) => !s.archived && (permitidos.length === 0 || permitidos.includes(s.id)),
        );

        const estrutura = await Promise.all(
          visiveis.map(async (espaco) => {
            const [{ folders }, { lists: soltas }] = await Promise.all([
              cliente.listarFolders(espaco.id),
              cliente.listarListasSemFolder(espaco.id),
            ]);

            const daPasta = await Promise.all(
              folders
                .filter((f) => !f.archived)
                .map(async (pasta) => ({
                  pasta: pasta.name,
                  listas: (
                    pasta.lists ??
                    (await cliente.listarListasDaFolder(pasta.id)).lists
                  )
                    .filter((l) => !l.archived)
                    .map((l) => ({
                      id: l.id,
                      nome: l.name,
                      status: (l.statuses ?? []).map((s) => s.status),
                    })),
                })),
            );

            return {
              espaco: espaco.name,
              listas: soltas
                .filter((l) => !l.archived)
                .map((l) => ({
                  id: l.id,
                  nome: l.name,
                  status: (l.statuses ?? []).map((s) => s.status),
                })),
              pastas: daPasta,
            };
          }),
        );

        return {
          listaPadrao: config.defaultListId || null,
          estrutura,
        };
      },
    },

    {
      name: "clickup_listar_membros",
      description:
        "Lista as pessoas do workspace com o id de cada uma. Chame antes de atribuir um responsável, para converter um nome em id.",
      inputSchema: z.object({}),
      async execute(_entrada, ctx) {
        const { cliente, config } = contexto(ctx);
        const membros = await membrosDoWorkspace(cliente, config.teamId);
        return membros.map((m) => ({
          id: m.id,
          nome: m.username ?? null,
          email: m.email ?? null,
        }));
      },
    },

    {
      name: "clickup_buscar_tarefas",
      description:
        "Procura tarefas. Aceita filtros por lista, status, responsável e vencimento. O filtro por texto é aplicado sobre o resultado — use junto com algum filtro estruturado para não trazer coisa demais.",
      inputSchema: z.object({
        texto: z
          .string()
          .optional()
          .describe("Trecho do nome ou da descrição da tarefa."),
        listaId: z.string().optional().describe("Restringe a uma lista."),
        status: z
          .array(z.string())
          .optional()
          .describe("Status exatos, como aparecem no ClickUp."),
        responsavel: z
          .string()
          .optional()
          .describe("Nome ou e-mail de quem é responsável."),
        vencendoAte: z
          .string()
          .optional()
          .describe("Data ISO (2026-08-31). Traz o que vence até essa data."),
        incluirFechadas: z.boolean().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          texto?: string;
          listaId?: string;
          status?: string[];
          responsavel?: string;
          vencendoAte?: string;
          incluirFechadas?: boolean;
        };
        const { cliente, config } = contexto(ctx);

        let assignees: number[] | undefined;
        if (args.responsavel) {
          const membros = await membrosDoWorkspace(cliente, config.teamId);
          const achado = resolverMembro(args.responsavel, membros);
          if (achado.tipo === "nenhum") {
            return `Ninguém no workspace corresponde a "${args.responsavel}".`;
          }
          if (achado.tipo === "ambiguo") {
            return {
              erro: "Mais de uma pessoa corresponde. Peça para especificar.",
              candidatos: achado.candidatos.map((c) => c.username ?? c.email),
            };
          }
          assignees = [achado.usuario.id];
        }

        const { tasks } = await cliente.buscarTarefas(config.teamId, {
          listIds: args.listaId ? [args.listaId] : undefined,
          spaceIds:
            config.spaceIdsPermitidos.length > 0
              ? config.spaceIdsPermitidos
              : undefined,
          statuses: args.status,
          assignees,
          vencimentoAntesDe: paraTimestamp(args.vencendoAte),
          incluirFechadas: args.incluirFechadas,
        });

        const filtradas = filtrarPorTexto(tasks, args.texto);
        return {
          total: filtradas.length,
          truncado: filtradas.length > LIMITE_RESULTADOS,
          tarefas: filtradas.slice(0, LIMITE_RESULTADOS).map(formatarTarefa),
        };
      },
    },

    {
      name: "clickup_obter_tarefa",
      description:
        "Detalhes de uma tarefa pelo id, incluindo descrição e os comentários mais recentes. Use quando precisar do histórico antes de responder ou atualizar.",
      inputSchema: z.object({
        tarefaId: z.string().describe("Id da tarefa no ClickUp."),
        incluirComentarios: z.boolean().optional().default(true),
      }),
      async execute(entrada, ctx) {
        const { tarefaId, incluirComentarios } = entrada as {
          tarefaId: string;
          incluirComentarios?: boolean;
        };
        const { cliente } = contexto(ctx);

        const tarefa = await cliente.obterTarefa(tarefaId);
        const detalhe = formatarTarefaDetalhada(tarefa);

        if (incluirComentarios === false) return detalhe;

        const { comments } = await cliente.listarComentarios(tarefaId);
        return {
          ...detalhe,
          comentarios: comments.slice(0, 10).map((c) => ({
            autor: c.user?.username ?? c.user?.email ?? null,
            texto: c.comment_text ?? "",
            resolvido: c.resolved ?? false,
          })),
        };
      },
    },

    // --- escrita ----------------------------------------------------------
    {
      name: "clickup_criar_tarefa",
      description:
        "Cria uma tarefa. Use quando o cliente pedir algo que a equipe precisa executar (manutenção, reserva, solicitação). Se não informar a lista, usa a lista padrão da configuração.",
      requiresConfirmation: true,
      inputSchema: z.object({
        nome: z.string().min(3).describe("Título curto e objetivo."),
        descricao: z
          .string()
          .optional()
          .describe("Contexto: quem pediu, o que precisa, prazo combinado."),
        listaId: z
          .string()
          .optional()
          .describe("Id da lista. Omita para usar a padrão."),
        status: z.string().optional().describe("Status inicial, se não for o padrão."),
        prioridade: prioridadeSchema.optional(),
        vencimento: z.string().optional().describe("Data ISO (2026-08-31)."),
        responsavel: z
          .string()
          .optional()
          .describe("Nome ou e-mail de quem vai executar."),
        tags: z.array(z.string()).optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          nome: string;
          descricao?: string;
          listaId?: string;
          status?: string;
          prioridade?: keyof typeof PRIORIDADES;
          vencimento?: string;
          responsavel?: string;
          tags?: string[];
        };
        const { cliente, config } = contexto(ctx);

        const listaId = args.listaId || config.defaultListId;
        if (!listaId) {
          return "Não há lista padrão configurada. Use clickup_listar_estrutura e informe a lista.";
        }

        let assignees: number[] | undefined;
        if (args.responsavel) {
          const membros = await membrosDoWorkspace(cliente, config.teamId);
          const achado = resolverMembro(args.responsavel, membros);
          if (achado.tipo !== "achado") {
            return `Não consegui identificar "${args.responsavel}" com segurança. Crie sem responsável ou confirme o nome.`;
          }
          assignees = [achado.usuario.id];
        }

        const tarefa = await cliente.criarTarefa(listaId, {
          name: args.nome,
          description: args.descricao,
          status: args.status,
          priority: args.prioridade ? PRIORIDADES[args.prioridade] : undefined,
          due_date: paraTimestamp(args.vencimento),
          assignees,
          tags: args.tags,
        });

        return { criada: true, ...formatarTarefa(tarefa) };
      },
    },

    {
      name: "clickup_atualizar_tarefa",
      description:
        "Altera uma tarefa existente: status, prioridade, vencimento, título ou descrição. Para mudar responsável use clickup_atribuir_responsavel.",
      requiresConfirmation: true,
      inputSchema: z.object({
        tarefaId: z.string(),
        status: z
          .string()
          .optional()
          .describe("Precisa ser um status válido da lista da tarefa."),
        prioridade: prioridadeSchema.optional(),
        vencimento: z.string().optional().describe("Data ISO."),
        nome: z.string().optional(),
        descricao: z.string().optional(),
        arquivar: z.boolean().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          tarefaId: string;
          status?: string;
          prioridade?: keyof typeof PRIORIDADES;
          vencimento?: string;
          nome?: string;
          descricao?: string;
          arquivar?: boolean;
        };
        const { cliente } = contexto(ctx);

        const tarefa = await cliente.atualizarTarefa(args.tarefaId, {
          name: args.nome,
          description: args.descricao,
          status: args.status,
          priority: args.prioridade ? PRIORIDADES[args.prioridade] : undefined,
          due_date: paraTimestamp(args.vencimento),
          archived: args.arquivar,
        });

        return { atualizada: true, ...formatarTarefa(tarefa) };
      },
    },

    {
      name: "clickup_atribuir_responsavel",
      description:
        "Adiciona ou remove responsáveis de uma tarefa. Aceita nome ou e-mail — resolve para o id internamente.",
      requiresConfirmation: true,
      inputSchema: z.object({
        tarefaId: z.string(),
        adicionar: z
          .array(z.string())
          .optional()
          .describe("Nomes ou e-mails de quem passa a ser responsável."),
        remover: z.array(z.string()).optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          tarefaId: string;
          adicionar?: string[];
          remover?: string[];
        };
        const { cliente, config } = contexto(ctx);

        if (!args.adicionar?.length && !args.remover?.length) {
          return "Informe ao menos uma pessoa para adicionar ou remover.";
        }

        const membros = await membrosDoWorkspace(cliente, config.teamId);
        const naoResolvidos: string[] = [];

        const paraIds = (termos: string[] = []) =>
          termos.flatMap((termo) => {
            const achado = resolverMembro(termo, membros);
            if (achado.tipo === "achado") return [achado.usuario.id];
            naoResolvidos.push(termo);
            return [];
          });

        const add = paraIds(args.adicionar);
        const rem = paraIds(args.remover);

        if (naoResolvidos.length > 0) {
          return {
            erro: "Não identifiquei todo mundo com segurança — nada foi alterado.",
            naoResolvidos,
          };
        }

        const tarefa = await cliente.atualizarTarefa(args.tarefaId, {
          assignees: { add, rem },
        });

        return { atualizada: true, ...formatarTarefa(tarefa) };
      },
    },

    {
      name: "clickup_comentar_tarefa",
      description:
        "Adiciona um comentário na tarefa. Use para registrar o que o cliente informou, sem alterar o status.",
      inputSchema: z.object({
        tarefaId: z.string(),
        texto: z.string().min(2),
        notificarTodos: z.boolean().optional().default(false),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          tarefaId: string;
          texto: string;
          notificarTodos?: boolean;
        };
        const { cliente } = contexto(ctx);

        await cliente.comentarTarefa(args.tarefaId, args.texto, {
          notificarTodos: args.notificarTodos,
        });

        return "Comentário adicionado.";
      },
    },
  ],
};
