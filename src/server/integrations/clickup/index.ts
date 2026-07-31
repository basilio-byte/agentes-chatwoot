import { z } from "zod";
import { IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition, ToolContext } from "../types";
import { clickupConfigSchema, type ClickUpConfig } from "./config";
import { ClickUpClient } from "./client";
import {
  deTimestamp,
  filtrarPorTexto,
  formatarTarefa,
  formatarTarefaDetalhada,
  normalizar,
  paraTimestamp,
  resolverMembro,
} from "./formatacao";
import { nomesDisponiveis, prepararCampos } from "./campos";
import { PRIORIDADES, type ClickUpSpace, type ClickUpUsuario } from "./tipos";

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

/** Espaços não arquivados, respeitando a allowlist da configuração. */
async function espacosVisiveis(
  cliente: ClickUpClient,
  config: ClickUpConfig,
): Promise<ClickUpSpace[]> {
  const { spaces } = await cliente.listarSpaces(config.teamId);
  const permitidos = config.spaceIdsPermitidos ?? [];
  return spaces.filter(
    (s) => !s.archived && (permitidos.length === 0 || permitidos.includes(s.id)),
  );
}

/**
 * Barra escrita fora dos espaços liberados na configuração.
 *
 * Sem isto a allowlist de espaços só valeria para leitura, e um agente poderia
 * criar pasta ou lista num espaço que o operador quis manter fora do alcance.
 */
function espacoBloqueado(config: ClickUpConfig, spaceId: string): string | null {
  const permitidos = config.spaceIdsPermitidos ?? [];
  if (permitidos.length === 0 || permitidos.includes(spaceId)) return null;
  return `O espaço ${spaceId} está fora dos espaços liberados para este sistema.`;
}

/**
 * Resolve o que o agente escreveu em `lista`: apelido cadastrado ou id cru.
 *
 * Apelido primeiro, sem acento nem caixa — o prompt diz "CRM Comercial", o
 * cadastro pode dizer "CRM comercial". Não casou, trata como id, porque o
 * agente pode ter descoberto um por `clickup_listar_listas`.
 *
 * Existe para o prompt falar por nome. Colar id cru no prompt é frágil (muda se
 * a lista for recriada), ilegível na revisão, e força uma chamada de descoberta
 * quando quem escreve o prompt não sabe o id.
 */
function resolverLista(
  termo: string | undefined,
  config: ClickUpConfig,
): { listaId: string | null; apelidos: string[] } {
  const cadastradas = config.listasNomeadas ?? [];
  const apelidos = cadastradas.map((l) => l.nome);

  if (!termo?.trim()) {
    return { listaId: config.defaultListId || null, apelidos };
  }

  const alvo = normalizar(termo);
  const porApelido = cadastradas.find((l) => normalizar(l.nome) === alvo);

  return {
    listaId: porApelido ? porApelido.listId : termo.trim(),
    apelidos,
  };
}

const prioridadeSchema = z
  .enum(["urgente", "alta", "normal", "baixa"])
  .describe("Prioridade da tarefa.");

const valorDeCampoSchema = z
  .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
  .describe(
    "Valor como o cliente informou — data ISO, número, sim/não ou o rótulo da opção. A conversão é feita internamente.",
  );

export const clickupIntegration: IntegrationDefinition = {
  provider: IntegrationProvider.CLICKUP,
  label: "ClickUp",
  descricao:
    "Consulta e administração do workspace: tarefas, listas, comentários, tags, checklists, tempo e campos personalizados.",
  configSchema: clickupConfigSchema,
  credentialLabel: "Token pessoal da API (pk_...)",

  async testarConexao(ctx) {
    const { cliente } = contexto(ctx);
    return cliente.testar();
  },

  tools: [
    // ======================================================================
    // Tarefas
    // ======================================================================
    {
      name: "clickup_listar_tarefas",
      categoria: "Tarefas",
      description:
        "Lista as tarefas de uma lista do ClickUp. Use quando já souber o id da lista — descubra com clickup_listar_listas. Para procurar no workspace inteiro use clickup_buscar_tarefas.",
      inputSchema: z.object({
        listaId: z
          .string()
          .optional()
          .describe("Id da lista. Omita para usar a lista padrão da configuração."),
        status: z
          .array(z.string())
          .optional()
          .describe("Filtra por status exatos, como aparecem no ClickUp."),
        incluirFechadas: z.boolean().optional(),
        pagina: z.number().int().min(0).optional().describe("Começa em 0."),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          listaId?: string;
          status?: string[];
          incluirFechadas?: boolean;
          pagina?: number;
        };
        const { cliente, config } = contexto(ctx);

        const listaId = args.listaId || config.defaultListId;
        if (!listaId) {
          return "Não há lista padrão configurada. Use clickup_listar_listas e informe a lista.";
        }

        const { tasks } = await cliente.listarTarefasDaLista(listaId, {
          statuses: args.status,
          incluirFechadas: args.incluirFechadas,
          page: args.pagina,
        });

        return {
          total: tasks.length,
          truncado: tasks.length > LIMITE_RESULTADOS,
          tarefas: tasks.slice(0, LIMITE_RESULTADOS).map(formatarTarefa),
        };
      },
    },

    {
      name: "clickup_criar_tarefa",
      categoria: "Tarefas",
      description:
        "Cria uma tarefa numa lista do ClickUp. Use quando o cliente pedir algo que a equipe precisa executar (manutenção, reserva, solicitação). Se não informar a lista, usa a lista padrão da configuração.",
      requiresConfirmation: true,
      inputSchema: z.object({
        nome: z.string().min(3).describe("Título curto e objetivo."),
        descricao: z
          .string()
          .optional()
          .describe("Contexto: quem pediu, o que precisa, prazo combinado."),
        lista: z
          .string()
          .optional()
          .describe(
            "Nome da lista cadastrada (ex.: \"CRM Comercial\") ou o id dela. Omita para usar a lista padrão da configuração.",
          ),
        status: z.string().optional().describe("Status inicial, se não for o padrão."),
        prioridade: prioridadeSchema.optional(),
        vencimento: z.string().optional().describe("Data ISO (2026-08-31)."),
        responsavel: z
          .string()
          .optional()
          .describe("Nome ou e-mail de quem vai executar."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tags já existentes no espaço."),
        camposPersonalizados: z
          .array(
            z.object({
              campo: z.string().describe("Nome do campo, como aparece no ClickUp."),
              valor: valorDeCampoSchema,
            }),
          )
          .optional()
          .describe(
            "Dados estruturados (CPF, e-mail, valor, periodicidade...). Preencha aqui em vez de escrever num comentário — o comentário não é pesquisável nem aparece em relatório.",
          ),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          nome: string;
          descricao?: string;
          lista?: string;
          status?: string;
          prioridade?: keyof typeof PRIORIDADES;
          vencimento?: string;
          responsavel?: string;
          tags?: string[];
          camposPersonalizados?: { campo: string; valor: unknown }[];
        };
        const { cliente, config } = contexto(ctx);

        const { listaId, apelidos } = resolverLista(args.lista, config);
        if (!listaId) {
          return {
            erro: "Não sei em qual lista criar. Informe a lista.",
            listasCadastradas: apelidos,
          };
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

        // Resolve nome → id antes de criar. Se algum campo não casar, não cria:
        // tarefa órfã com metade dos dados é pior do que pedir a correção.
        let custom_fields: { id: string; value: unknown }[] | undefined;
        if (args.camposPersonalizados?.length) {
          const { fields } = await cliente.listarCamposPersonalizados(listaId);
          const { prontos, problemas } = prepararCampos(
            args.camposPersonalizados,
            fields,
          );

          if (problemas.length > 0) {
            return {
              erro: "Não criei a tarefa — corrija os campos e chame de novo.",
              problemas,
              camposDisponiveis: nomesDisponiveis(fields),
            };
          }
          custom_fields = prontos;
        }

        const tarefa = await cliente.criarTarefa(listaId, {
          name: args.nome,
          description: args.descricao,
          status: args.status,
          priority: args.prioridade ? PRIORIDADES[args.prioridade] : undefined,
          due_date: paraTimestamp(args.vencimento),
          assignees,
          tags: args.tags,
          custom_fields,
        });

        return {
          criada: true,
          camposPreenchidos: custom_fields?.length ?? 0,
          ...formatarTarefa(tarefa),
        };
      },
    },

    {
      name: "clickup_obter_tarefa",
      categoria: "Tarefas",
      description:
        "Busca os detalhes completos de uma tarefa do ClickUp (descrição, prioridade, prazo, tags, responsáveis, link) e os comentários mais recentes. Use quando precisar do histórico antes de responder ou atualizar.",
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

    {
      name: "clickup_atualizar_tarefa",
      categoria: "Tarefas",
      description:
        "Atualiza nome, descrição, prioridade e/ou prazo de uma tarefa do ClickUp (informe pelo menos um campo além do id). Para mudar status use clickup_mudar_status; para responsáveis, clickup_atribuir_responsavel.",
      requiresConfirmation: true,
      inputSchema: z.object({
        tarefaId: z.string(),
        nome: z.string().optional(),
        descricao: z.string().optional(),
        prioridade: prioridadeSchema.optional(),
        vencimento: z.string().optional().describe("Data ISO."),
        arquivar: z.boolean().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          tarefaId: string;
          nome?: string;
          descricao?: string;
          prioridade?: keyof typeof PRIORIDADES;
          vencimento?: string;
          arquivar?: boolean;
        };
        const { cliente } = contexto(ctx);

        const mudou =
          args.nome !== undefined ||
          args.descricao !== undefined ||
          args.prioridade !== undefined ||
          args.vencimento !== undefined ||
          args.arquivar !== undefined;
        if (!mudou) {
          return "Informe pelo menos um campo para alterar além do id da tarefa.";
        }

        const tarefa = await cliente.atualizarTarefa(args.tarefaId, {
          name: args.nome,
          description: args.descricao,
          priority: args.prioridade ? PRIORIDADES[args.prioridade] : undefined,
          due_date: paraTimestamp(args.vencimento),
          archived: args.arquivar,
        });

        return { atualizada: true, ...formatarTarefa(tarefa) };
      },
    },

    {
      name: "clickup_mudar_status",
      categoria: "Tarefas",
      description:
        "Atualiza o status de uma tarefa do ClickUp. O status precisa existir na lista da tarefa — confira os nomes aceitos com clickup_listar_estrutura antes de chamar.",
      requiresConfirmation: true,
      inputSchema: z.object({
        tarefaId: z.string(),
        status: z
          .string()
          .describe("Nome exato do status, como aparece na lista da tarefa."),
      }),
      async execute(entrada, ctx) {
        const { tarefaId, status } = entrada as {
          tarefaId: string;
          status: string;
        };
        const { cliente } = contexto(ctx);

        const tarefa = await cliente.atualizarTarefa(tarefaId, { status });
        return { atualizada: true, ...formatarTarefa(tarefa) };
      },
    },

    {
      name: "clickup_excluir_tarefa",
      categoria: "Tarefas",
      description:
        "Exclui uma tarefa do ClickUp permanentemente. Não tem desfazer — se a intenção for só tirar da frente, prefira mudar o status ou arquivar com clickup_atualizar_tarefa.",
      requiresConfirmation: true,
      inputSchema: z.object({
        tarefaId: z.string(),
      }),
      async execute(entrada, ctx) {
        const { tarefaId } = entrada as { tarefaId: string };
        const { cliente } = contexto(ctx);

        await cliente.excluirTarefa(tarefaId);
        return `Tarefa ${tarefaId} excluída permanentemente.`;
      },
    },

    {
      name: "clickup_buscar_tarefas",
      categoria: "Tarefas",
      description:
        "Busca tarefas no workspace do ClickUp filtrando por listas, responsáveis, status e/ou vencimento. O filtro por texto é aplicado sobre o resultado — use junto com algum filtro estruturado para não trazer coisa demais.",
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
      name: "clickup_atribuir_responsavel",
      categoria: "Tarefas",
      description:
        "Atribui uma tarefa do ClickUp a uma ou mais pessoas, ou remove quem está atribuído. Aceita nome ou e-mail — resolve para o id internamente. Quem já era responsável continua, a não ser que apareça em 'remover'.",
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

    // ======================================================================
    // Listas
    // ======================================================================
    {
      name: "clickup_listar_listas",
      categoria: "Listas",
      description:
        "Lista as listas do workspace ClickUp, com o espaço e a pasta de cada uma. Use para descobrir o id da lista antes de clickup_criar_tarefa ou clickup_listar_tarefas.",
      inputSchema: z.object({}),
      async execute(_entrada, ctx) {
        const { cliente, config } = contexto(ctx);
        const espacos = await espacosVisiveis(cliente, config);

        const porEspaco = await Promise.all(
          espacos.map(async (espaco) => {
            const [{ folders }, { lists: soltas }] = await Promise.all([
              cliente.listarFolders(espaco.id),
              cliente.listarListasSemFolder(espaco.id),
            ]);

            const daPasta = await Promise.all(
              folders
                .filter((f) => !f.archived)
                .map(async (pasta) => {
                  const listas =
                    pasta.lists ??
                    (await cliente.listarListasDaFolder(pasta.id)).lists;
                  return listas
                    .filter((l) => !l.archived)
                    .map((l) => ({
                      id: l.id,
                      nome: l.name,
                      espaco: espaco.name,
                      pasta: pasta.name,
                    }));
                }),
            );

            return [
              ...soltas
                .filter((l) => !l.archived)
                .map((l) => ({
                  id: l.id,
                  nome: l.name,
                  espaco: espaco.name,
                  pasta: null as string | null,
                })),
              ...daPasta.flat(),
            ];
          }),
        );

        const listas = porEspaco.flat();
        return { listaPadrao: config.defaultListId || null, total: listas.length, listas };
      },
    },

    {
      name: "clickup_criar_lista",
      categoria: "Listas",
      description:
        "Cria uma lista no ClickUp — informe pastaId para criar dentro de uma pasta, ou espacoId para criar solta no espaço. Descubra os ids com clickup_listar_estrutura.",
      requiresConfirmation: true,
      inputSchema: z.object({
        nome: z.string().min(1),
        pastaId: z.string().optional().describe("Cria dentro desta pasta."),
        espacoId: z
          .string()
          .optional()
          .describe("Cria solta neste espaço. Ignorado se pastaId for informado."),
        descricao: z.string().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          nome: string;
          pastaId?: string;
          espacoId?: string;
          descricao?: string;
        };
        const { cliente, config } = contexto(ctx);

        if (!args.pastaId && !args.espacoId) {
          return "Informe pastaId (lista dentro de uma pasta) ou espacoId (lista solta).";
        }

        if (args.espacoId && !args.pastaId) {
          const bloqueio = espacoBloqueado(config, args.espacoId);
          if (bloqueio) return bloqueio;
        }

        const lista = args.pastaId
          ? await cliente.criarListaEmFolder(args.pastaId, {
              name: args.nome,
              content: args.descricao,
            })
          : await cliente.criarListaEmSpace(args.espacoId!, {
              name: args.nome,
              content: args.descricao,
            });

        return { criada: true, id: lista.id, nome: lista.name };
      },
    },

    // ======================================================================
    // Espaços e pastas
    // ======================================================================
    {
      name: "clickup_listar_estrutura",
      categoria: "Espaços e pastas",
      description:
        "Lista os espaços, pastas e listas do ClickUp, com os status válidos de cada lista. Chame antes de criar uma tarefa quando não souber em qual lista ela deve entrar, ou antes de mudar status, para saber os nomes aceitos.",
      inputSchema: z.object({}),
      async execute(_entrada, ctx) {
        const { cliente, config } = contexto(ctx);
        const visiveis = await espacosVisiveis(cliente, config);

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
                  id: pasta.id,
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
              id: espaco.id,
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
      name: "clickup_criar_pasta",
      categoria: "Espaços e pastas",
      description:
        "Cria uma pasta (folder) dentro de um espaço do ClickUp. Descubra o id do espaço com clickup_listar_estrutura.",
      requiresConfirmation: true,
      inputSchema: z.object({
        espacoId: z.string(),
        nome: z.string().min(1),
      }),
      async execute(entrada, ctx) {
        const { espacoId, nome } = entrada as { espacoId: string; nome: string };
        const { cliente, config } = contexto(ctx);

        const bloqueio = espacoBloqueado(config, espacoId);
        if (bloqueio) return bloqueio;

        const pasta = await cliente.criarFolder(espacoId, nome);
        return { criada: true, id: pasta.id, nome: pasta.name };
      },
    },

    // ======================================================================
    // Comentários
    // ======================================================================
    {
      name: "clickup_comentar_tarefa",
      categoria: "Comentários",
      description:
        "Adiciona um comentário a uma tarefa do ClickUp. Use para registrar o que o cliente informou, sem alterar o status.",
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

        const { id } = await cliente.comentarTarefa(args.tarefaId, args.texto, {
          notificarTodos: args.notificarTodos,
        });

        return { comentado: true, comentarioId: id };
      },
    },

    {
      name: "clickup_listar_comentarios",
      categoria: "Comentários",
      description:
        "Lista os comentários de uma tarefa do ClickUp, com autor e id de cada um. Use para achar o id antes de editar ou excluir um comentário.",
      inputSchema: z.object({
        tarefaId: z.string(),
      }),
      async execute(entrada, ctx) {
        const { tarefaId } = entrada as { tarefaId: string };
        const { cliente } = contexto(ctx);

        const { comments } = await cliente.listarComentarios(tarefaId);
        return {
          total: comments.length,
          comentarios: comments.slice(0, LIMITE_RESULTADOS).map((c) => ({
            id: c.id,
            autor: c.user?.username ?? c.user?.email ?? null,
            texto: c.comment_text ?? "",
            data: deTimestamp(c.date),
            resolvido: c.resolved ?? false,
          })),
        };
      },
    },

    {
      name: "clickup_editar_comentario",
      categoria: "Comentários",
      description:
        "Edita o texto de um comentário existente no ClickUp, ou marca como resolvido. Pegue o id com clickup_listar_comentarios.",
      requiresConfirmation: true,
      inputSchema: z.object({
        comentarioId: z.string(),
        texto: z.string().optional(),
        resolvido: z.boolean().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          comentarioId: string;
          texto?: string;
          resolvido?: boolean;
        };
        const { cliente } = contexto(ctx);

        if (args.texto === undefined && args.resolvido === undefined) {
          return "Informe o novo texto ou o estado de resolvido.";
        }

        await cliente.editarComentario(args.comentarioId, {
          comment_text: args.texto,
          resolved: args.resolvido,
        });

        return "Comentário atualizado.";
      },
    },

    {
      name: "clickup_excluir_comentario",
      categoria: "Comentários",
      description:
        "Exclui um comentário do ClickUp. Pegue o id com clickup_listar_comentarios.",
      requiresConfirmation: true,
      inputSchema: z.object({
        comentarioId: z.string(),
      }),
      async execute(entrada, ctx) {
        const { comentarioId } = entrada as { comentarioId: string };
        const { cliente } = contexto(ctx);

        await cliente.excluirComentario(comentarioId);
        return "Comentário excluído.";
      },
    },

    // ======================================================================
    // Tags
    // ======================================================================
    {
      name: "clickup_listar_tags",
      categoria: "Tags",
      description:
        "Lista as tags disponíveis num espaço do ClickUp. Chame antes de clickup_adicionar_tag: só dá para aplicar tag que já existe no espaço.",
      inputSchema: z.object({
        espacoId: z.string(),
      }),
      async execute(entrada, ctx) {
        const { espacoId } = entrada as { espacoId: string };
        const { cliente, config } = contexto(ctx);

        const bloqueio = espacoBloqueado(config, espacoId);
        if (bloqueio) return bloqueio;

        const { tags } = await cliente.listarTags(espacoId);
        return tags.map((t) => t.name);
      },
    },

    {
      name: "clickup_adicionar_tag",
      categoria: "Tags",
      description:
        "Adiciona a uma tarefa do ClickUp uma tag que já existe no espaço. Confira os nomes com clickup_listar_tags — esta chamada não cria tag nova.",
      requiresConfirmation: true,
      inputSchema: z.object({
        tarefaId: z.string(),
        tag: z.string().describe("Nome exato da tag, como existe no espaço."),
      }),
      async execute(entrada, ctx) {
        const { tarefaId, tag } = entrada as { tarefaId: string; tag: string };
        const { cliente } = contexto(ctx);

        await cliente.adicionarTag(tarefaId, tag);
        return `Tag "${tag}" adicionada à tarefa ${tarefaId}.`;
      },
    },

    {
      name: "clickup_remover_tag",
      categoria: "Tags",
      description:
        "Remove uma tag de uma tarefa do ClickUp. A tag continua existindo no espaço, só deixa de estar nesta tarefa.",
      requiresConfirmation: true,
      inputSchema: z.object({
        tarefaId: z.string(),
        tag: z.string(),
      }),
      async execute(entrada, ctx) {
        const { tarefaId, tag } = entrada as { tarefaId: string; tag: string };
        const { cliente } = contexto(ctx);

        await cliente.removerTag(tarefaId, tag);
        return `Tag "${tag}" removida da tarefa ${tarefaId}.`;
      },
    },

    // ======================================================================
    // Checklists
    // ======================================================================
    {
      name: "clickup_criar_checklist",
      categoria: "Checklists",
      description:
        "Cria um checklist numa tarefa do ClickUp. Devolve o id do checklist, necessário para adicionar itens.",
      requiresConfirmation: true,
      inputSchema: z.object({
        tarefaId: z.string(),
        nome: z.string().min(1).describe("Título do checklist."),
      }),
      async execute(entrada, ctx) {
        const { tarefaId, nome } = entrada as { tarefaId: string; nome: string };
        const { cliente } = contexto(ctx);

        const { checklist } = await cliente.criarChecklist(tarefaId, nome);
        return { criado: true, checklistId: checklist.id, nome: checklist.name };
      },
    },

    {
      name: "clickup_adicionar_item_checklist",
      categoria: "Checklists",
      description:
        "Adiciona um item a um checklist do ClickUp. O id do checklist vem de clickup_criar_checklist ou de clickup_obter_tarefa.",
      requiresConfirmation: true,
      inputSchema: z.object({
        checklistId: z.string(),
        nome: z.string().min(1),
        concluido: z.boolean().optional().default(false),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          checklistId: string;
          nome: string;
          concluido?: boolean;
        };
        const { cliente } = contexto(ctx);

        const { checklist } = await cliente.adicionarItemChecklist(
          args.checklistId,
          { name: args.nome, resolved: args.concluido },
        );

        return {
          adicionado: true,
          itens: (checklist.items ?? []).map((i) => ({
            id: i.id,
            nome: i.name,
            concluido: i.resolved ?? false,
          })),
        };
      },
    },

    {
      name: "clickup_atualizar_item_checklist",
      categoria: "Checklists",
      description:
        "Renomeia e/ou marca como concluído ou pendente um item de checklist do ClickUp (informe pelo menos nome ou concluido).",
      requiresConfirmation: true,
      inputSchema: z.object({
        checklistId: z.string(),
        itemId: z.string(),
        nome: z.string().optional(),
        concluido: z.boolean().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          checklistId: string;
          itemId: string;
          nome?: string;
          concluido?: boolean;
        };
        const { cliente } = contexto(ctx);

        if (args.nome === undefined && args.concluido === undefined) {
          return "Informe o novo nome ou se o item está concluído.";
        }

        await cliente.atualizarItemChecklist(args.checklistId, args.itemId, {
          name: args.nome,
          resolved: args.concluido,
        });

        return "Item do checklist atualizado.";
      },
    },

    {
      name: "clickup_excluir_item_checklist",
      categoria: "Checklists",
      description:
        "Exclui um item de um checklist do ClickUp.",
      requiresConfirmation: true,
      inputSchema: z.object({
        checklistId: z.string(),
        itemId: z.string(),
      }),
      async execute(entrada, ctx) {
        const { checklistId, itemId } = entrada as {
          checklistId: string;
          itemId: string;
        };
        const { cliente } = contexto(ctx);

        await cliente.excluirItemChecklist(checklistId, itemId);
        return "Item do checklist excluído.";
      },
    },

    // ======================================================================
    // Registro de tempo
    // ======================================================================
    {
      name: "clickup_iniciar_cronometro",
      categoria: "Registro de tempo",
      description:
        "Inicia um cronômetro numa tarefa do ClickUp. O tempo é sempre registrado para o dono do token configurado — a API não permite cronometrar em nome de outra pessoa.",
      requiresConfirmation: true,
      inputSchema: z.object({
        tarefaId: z.string(),
        descricao: z.string().optional(),
      }),
      async execute(entrada, ctx) {
        const { tarefaId, descricao } = entrada as {
          tarefaId: string;
          descricao?: string;
        };
        const { cliente, config } = contexto(ctx);

        await cliente.iniciarCronometro(config.teamId, {
          tid: tarefaId,
          description: descricao,
        });
        return `Cronômetro iniciado na tarefa ${tarefaId}.`;
      },
    },

    {
      name: "clickup_parar_cronometro",
      categoria: "Registro de tempo",
      description:
        "Para o cronômetro que estiver rodando no ClickUp para o dono do token configurado.",
      requiresConfirmation: true,
      inputSchema: z.object({}),
      async execute(_entrada, ctx) {
        const { cliente, config } = contexto(ctx);

        const { data } = await cliente.pararCronometro(config.teamId);
        const minutos = data?.duration
          ? Math.round(Number(data.duration) / 60_000)
          : null;

        return minutos === null
          ? "Cronômetro parado."
          : `Cronômetro parado — ${minutos} minuto(s) registrados.`;
      },
    },

    {
      name: "clickup_registrar_tempo",
      categoria: "Registro de tempo",
      description:
        "Registra manualmente um período de tempo trabalhado numa tarefa do ClickUp, sem usar cronômetro.",
      requiresConfirmation: true,
      inputSchema: z.object({
        tarefaId: z.string(),
        inicio: z
          .string()
          .describe("Início do período, ISO com hora (2026-08-05T14:00:00)."),
        duracaoMinutos: z.number().int().positive(),
        descricao: z.string().optional(),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          tarefaId: string;
          inicio: string;
          duracaoMinutos: number;
          descricao?: string;
        };
        const { cliente, config } = contexto(ctx);

        const inicio = paraTimestamp(args.inicio);
        if (!inicio) {
          return `Não entendi a data "${args.inicio}". Use o formato ISO, como 2026-08-05T14:00:00.`;
        }

        await cliente.registrarTempo(config.teamId, {
          tid: args.tarefaId,
          start: inicio,
          duration: args.duracaoMinutos * 60_000,
          description: args.descricao,
        });

        return `${args.duracaoMinutos} minuto(s) registrados na tarefa ${args.tarefaId}.`;
      },
    },

    {
      name: "clickup_listar_registros_de_tempo",
      categoria: "Registro de tempo",
      description:
        "Lista os registros de tempo do workspace ClickUp, opcionalmente filtrados por tarefa e por período.",
      inputSchema: z.object({
        tarefaId: z.string().optional(),
        de: z.string().optional().describe("Data ISO inicial."),
        ate: z.string().optional().describe("Data ISO final."),
      }),
      async execute(entrada, ctx) {
        const args = entrada as { tarefaId?: string; de?: string; ate?: string };
        const { cliente, config } = contexto(ctx);

        const { data } = await cliente.listarRegistrosDeTempo(config.teamId, {
          taskId: args.tarefaId,
          inicio: paraTimestamp(args.de),
          fim: paraTimestamp(args.ate),
        });

        const registros = data ?? [];
        return {
          total: registros.length,
          registros: registros.slice(0, LIMITE_RESULTADOS).map((r) => ({
            id: r.id,
            tarefa: r.task?.name ?? r.task?.id ?? null,
            pessoa: r.user?.username ?? r.user?.email ?? null,
            minutos: r.duration ? Math.round(Number(r.duration) / 60_000) : null,
            inicio: deTimestamp(r.start),
            descricao: r.description ?? null,
          })),
        };
      },
    },

    // ======================================================================
    // Relacionamentos entre tarefas
    // ======================================================================
    {
      name: "clickup_definir_dependencia",
      categoria: "Relacionamentos entre tarefas",
      description:
        "Cria uma dependência entre tarefas do ClickUp: a tarefa fica bloqueada até a outra ser concluída (esperaPor), ou bloqueia a outra (bloqueia). Informe exatamente um dos dois.",
      requiresConfirmation: true,
      inputSchema: z.object({
        tarefaId: z.string(),
        esperaPor: z
          .string()
          .optional()
          .describe("Id da tarefa que precisa terminar antes desta."),
        bloqueia: z
          .string()
          .optional()
          .describe("Id da tarefa que só pode começar depois desta."),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          tarefaId: string;
          esperaPor?: string;
          bloqueia?: string;
        };
        const { cliente } = contexto(ctx);

        if (Boolean(args.esperaPor) === Boolean(args.bloqueia)) {
          return "Informe exatamente um: esperaPor (esta espera a outra) ou bloqueia (a outra espera esta).";
        }

        await cliente.definirDependencia(args.tarefaId, {
          depends_on: args.esperaPor,
          dependency_of: args.bloqueia,
        });

        return args.esperaPor
          ? `Tarefa ${args.tarefaId} agora depende de ${args.esperaPor}.`
          : `Tarefa ${args.bloqueia} agora depende de ${args.tarefaId}.`;
      },
    },

    {
      name: "clickup_vincular_tarefas",
      categoria: "Relacionamentos entre tarefas",
      description:
        "Vincula duas tarefas do ClickUp entre si. É só uma referência cruzada — não bloqueia nem cria ordem de execução; para isso use clickup_definir_dependencia.",
      requiresConfirmation: true,
      inputSchema: z.object({
        tarefaId: z.string(),
        outraTarefaId: z.string(),
      }),
      async execute(entrada, ctx) {
        const { tarefaId, outraTarefaId } = entrada as {
          tarefaId: string;
          outraTarefaId: string;
        };
        const { cliente } = contexto(ctx);

        await cliente.vincularTarefas(tarefaId, outraTarefaId);
        return `Tarefas ${tarefaId} e ${outraTarefaId} vinculadas.`;
      },
    },

    // ======================================================================
    // Campos personalizados
    // ======================================================================
    {
      name: "clickup_listar_campos_personalizados",
      categoria: "Campos personalizados",
      description:
        "Lista os campos personalizados disponíveis numa lista do ClickUp, com o id, o tipo e as opções de cada um. Chame antes de clickup_definir_campo_personalizado.",
      inputSchema: z.object({
        listaId: z.string(),
      }),
      async execute(entrada, ctx) {
        const { listaId } = entrada as { listaId: string };
        const { cliente } = contexto(ctx);

        const { fields } = await cliente.listarCamposPersonalizados(listaId);
        return fields.map((f) => ({
          id: f.id,
          nome: f.name,
          tipo: f.type,
          opcoes: (f.type_config?.options ?? []).map((o) => ({
            id: o.id,
            nome: o.name ?? o.label ?? null,
          })),
        }));
      },
    },

    {
      name: "clickup_definir_campo_personalizado",
      categoria: "Campos personalizados",
      description:
        "Preenche um ou mais campos personalizados de uma tarefa que já existe no ClickUp. Informe o campo pelo nome — a conversão para o formato da API (datas, números, opções de seleção) é feita aqui. Ao criar a tarefa, prefira passar os campos direto em clickup_criar_tarefa.",
      requiresConfirmation: true,
      inputSchema: z.object({
        tarefaId: z.string(),
        campos: z
          .array(
            z.object({
              campo: z.string().describe("Nome do campo, como aparece no ClickUp."),
              valor: valorDeCampoSchema,
            }),
          )
          .min(1),
      }),
      async execute(entrada, ctx) {
        const args = entrada as {
          tarefaId: string;
          campos: { campo: string; valor: unknown }[];
        };
        const { cliente } = contexto(ctx);

        // Os campos são definidos por lista, então descobrimos a lista pela
        // própria tarefa — o agente não precisa saber disso.
        const tarefa = await cliente.obterTarefa(args.tarefaId);
        const listaId = tarefa.list?.id;
        if (!listaId) {
          return "Não consegui descobrir a lista desta tarefa para validar os campos.";
        }

        const { fields } = await cliente.listarCamposPersonalizados(listaId);
        const { prontos, problemas } = prepararCampos(args.campos, fields);

        if (problemas.length > 0) {
          return {
            erro: "Nada foi alterado — corrija os campos e chame de novo.",
            problemas,
            camposDisponiveis: nomesDisponiveis(fields),
          };
        }

        // A API grava um campo por requisição; o lote é só para o agente.
        for (const campo of prontos) {
          await cliente.definirCampoPersonalizado(
            args.tarefaId,
            campo.id,
            campo.value,
          );
        }

        return `${prontos.length} campo(s) preenchido(s) na tarefa ${args.tarefaId}.`;
      },
    },

    // ======================================================================
    // Membros
    // ======================================================================
    {
      name: "clickup_listar_membros",
      categoria: "Membros",
      description:
        "Lista as pessoas do workspace ClickUp com o id de cada uma. Chame antes de atribuir um responsável, para converter um nome em id.",
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
  ],
};
