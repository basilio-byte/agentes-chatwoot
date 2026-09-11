import { z } from "zod";
import { db } from "@/lib/db";
import {
  IntegrationProvider,
  RunSource,
  RunStatus,
  UserRole,
} from "@/generated/prisma/enums";
import { ROTULO_DA_FONTE } from "@/lib/origens";
import { diaEmSaoPaulo } from "@/lib/tempo";
import { prepararContexto } from "@/server/agents/contexto";
import { lerCron } from "@/server/agenda/cron";
import { agregar, SEM_MODELO, type Fatia } from "@/server/consumo/agregacao";
import {
  montarWhere,
  TETO_DE_LINHAS,
  varrerPeriodo,
} from "@/server/consumo/consulta";
import {
  diasDoIntervalo,
  intervaloDoPeriodo,
  PERIODOS,
  type Periodo,
} from "@/server/consumo/periodo";
import { lerDetalheDaExecucao } from "@/server/execucoes/detalhe";
import {
  listarIntegracoes,
  obterIntegracao,
} from "@/server/integrations/registry";
import {
  tokensAproximadosDaTool,
  toolsLiberadas,
} from "@/server/integrations/resolve";
import { conferirCitacoes } from "../citacoes";
import { contarMudancas, diffPorLinha, formatarDiff } from "../diff";
import { ferramenta, type FerramentaMcp } from "../executor";
import {
  arredondarUsd,
  quando,
  recortarTexto,
  recusar,
  responder,
  semSegredos,
  tokensAproximados,
} from "../formato";
import { carimbo, normalizarQuebras } from "../prompt";
import {
  acharAgente,
  agenteNaoEncontrado,
  campoAgente,
  localizarFerramenta,
  nomesDoCatalogo,
} from "./comum";

/**
 * Ferramentas de consulta. Nenhuma altera nada, e todas valem para Leitura.
 *
 * ⚠ Nada aqui devolve credencial, máscara de token ou secret — nem para o
 * Proprietário. O que o painel mostra só a quem pode ver fica no painel.
 */

/** Períodos que cabem num parâmetro só: `custom` exigiria duas datas. */
const PERIODOS_DO_MCP = PERIODOS.filter((p) => p !== "custom") as [
  Periodo,
  ...Periodo[],
];

const CONSULTA = { readOnlyHint: true } as const;

function contarEfetivas(
  vinculos: {
    enabled: boolean;
    allowedTools: string[];
    integration: { provider: IntegrationProvider; enabled: boolean };
  }[],
): number {
  let total = 0;
  for (const v of vinculos) {
    if (!v.enabled || !v.integration.enabled) continue;
    const definicao = obterIntegracao(v.integration.provider);
    if (definicao) total += toolsLiberadas(definicao, v.allowedTools).length;
  }
  return total;
}

const listarAgentes = ferramenta({
  name: "listar_agentes",
  title: "Listar agentes",
  description:
    "Lista os agentes com o estado de cada um: ligado, agente de entrada, arquivado, modelo, versão do prompt e quantas ferramentas ele enxerga de fato (ligadas nos dois níveis, depois da restrição). Comece por aqui: as outras ferramentas pedem a chave (key) do agente.",
  papel: UserRole.VIEWER,
  anotacoes: CONSULTA,
  entrada: z.strictObject({
    incluirArquivados: z.boolean().optional().describe("Padrão: falso."),
  }),
  async executar({ incluirArquivados }) {
    const agentes = await db.agent.findMany({
      where: incluirArquivados ? {} : { archivedAt: null },
      orderBy: [{ isEntry: "desc" }, { name: "asc" }],
      include: {
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { version: true },
        },
        trigger: { select: { enabled: true } },
        schedules: { select: { enabled: true } },
        integrations: {
          select: {
            enabled: true,
            allowedTools: true,
            integration: { select: { provider: true, enabled: true } },
          },
        },
      },
    });

    return responder({
      total: agentes.length,
      agentes: agentes.map((a) => ({
        key: a.key,
        id: a.id,
        nome: a.name,
        descricao: a.description,
        ligado: a.active,
        entrada: a.isEntry,
        arquivadoEm: quando(a.archivedAt),
        modelo: a.model,
        effort: a.effort,
        versaoDoPrompt: a.versions[0]?.version ?? null,
        caracteresDoPrompt: a.systemPrompt.length,
        // Sem descrição de roteamento o agente some do roster: nenhum colega
        // transfere para ele.
        colegasPodemTransferir: Boolean(a.routingDescription?.trim()),
        ferramentasEfetivas: contarEfetivas(a.integrations),
        gatilhoHttp: a.trigger
          ? a.trigger.enabled
            ? "ligado"
            : "desligado"
          : "não gerado",
        agendamentosLigados: a.schedules.filter((s) => s.enabled).length,
        atualizadoEm: quando(a.updatedAt),
      })),
    });
  },
});

const verAgente = ferramenta({
  name: "ver_agente",
  title: "Ver agente",
  description:
    "Tudo sobre um agente: prompt completo (com baseHash para alterar), modelo, ferramentas que ele enxerga de fato, integrações nos dois níveis, escopo de caixas, responsável padrão, gatilho, agendamentos e alertas do prompt (ferramentas citadas que não estão ligadas, nomes de parâmetro de outro sistema). Leia antes de propor qualquer alteração.",
  papel: UserRole.VIEWER,
  anotacoes: CONSULTA,
  entrada: z.strictObject({ agente: campoAgente }),
  async executar({ agente: termo }, ctx) {
    const agente = await acharAgente(termo);
    if (!agente) return agenteNaoEncontrado(termo);

    const [detalhes, configuradas, contexto] = await Promise.all([
      db.agent.findUniqueOrThrow({
        where: { id: agente.id },
        select: {
          owner: { select: { name: true } },
          updatedBy: { select: { name: true } },
          chatwootBot: { select: { botName: true, botId: true, accountId: true } },
          trigger: {
            select: {
              enabled: true,
              pausadoAutomaticamenteEm: true,
              pausadoAutomaticamenteMotivo: true,
            },
          },
          schedules: {
            orderBy: { createdAt: "asc" },
            select: { id: true, nome: true, cron: true, enabled: true },
          },
          versions: {
            orderBy: { version: "desc" },
            take: 1,
            select: { version: true },
          },
          integrations: {
            select: {
              enabled: true,
              allowedTools: true,
              integration: { select: { provider: true } },
            },
          },
        },
      }),
      db.integration.findMany({ select: { provider: true, enabled: true } }),
      // A mesma conta que o turno faz — ferramentas e modelo de verdade.
      prepararContexto(agente, RunSource.CHATWOOT),
    ]);

    const efetivas = new Set(contexto.resolvidas.keys());
    const citacoes = conferirCitacoes(
      normalizarQuebras(agente.systemPrompt),
      nomesDoCatalogo(),
      efetivas,
    );
    const temAlerta =
      citacoes.naoLigadas.length > 0 || citacoes.parametrosSuspeitos.length > 0;

    return responder({
      key: agente.key,
      id: agente.id,
      nome: agente.name,
      descricao: agente.description,
      estado: {
        ligado: agente.active,
        entrada: agente.isEntry,
        arquivadoEm: quando(agente.archivedAt),
      },
      modelo: {
        slug: agente.model,
        noCatalogoDaOpenRouter: Boolean(contexto.modelo),
        aceitaFerramentas: contexto.modelo?.suportaTools ?? null,
        effort: agente.effort,
        maxTokens: agente.maxTokens,
        maxToolIterations: agente.maxToolIterations,
      },
      descricaoDeRoteamento: agente.routingDescription,
      prompt: {
        versao: detalhes.versions[0]?.version ?? null,
        baseHash: carimbo(agente.systemPrompt),
        caracteres: agente.systemPrompt.length,
        texto: agente.systemPrompt,
      },
      ferramentasEfetivas: {
        vaoNaRequisicao: contexto.enviarFerramentas,
        ...(efetivas.size > 0 && !contexto.enviarFerramentas
          ? {
              motivo:
                "O modelo não aceita ferramentas: nenhuma vai na requisição, apesar de ligadas.",
            }
          : {}),
        nomes: [...efetivas].sort(),
      },
      alertasDoPrompt: temAlerta
        ? {
            ferramentasCitadasNaoLigadas: citacoes.naoLigadas,
            parametrosDeOutroSistema: citacoes.parametrosSuspeitos,
          }
        : null,
      integracoes: listarIntegracoes().map((definicao) => {
        const registro = configuradas.find(
          (i) => i.provider === definicao.provider,
        );
        const vinculo = detalhes.integrations.find(
          (v) => v.integration.provider === definicao.provider,
        );
        return {
          provider: definicao.provider,
          nome: definicao.label,
          ligadaGlobalmente: registro?.enabled ?? false,
          ligadaNoAgente: vinculo?.enabled ?? false,
          liberadas:
            vinculo && vinculo.allowedTools.length > 0
              ? vinculo.allowedTools
              : "todas",
          ferramentasNaIntegracao: definicao.tools.length,
        };
      }),
      escopo: {
        modoDeCaixa: agente.inboxMode,
        caixas: agente.inboxIds,
        contaChatwoot: detalhes.chatwootBot?.accountId ?? "herda a de Integrações",
        minutosDeEspera: agente.fallbackMinutos,
        responsavelPadrao: agente.fallbackAtendente,
      },
      canal: detalhes.chatwootBot
        ? { bot: detalhes.chatwootBot.botName, botId: detalhes.chatwootBot.botId }
        : "sem bot próprio (atende por transferência)",
      transferenciaParaPessoa: {
        habilitada: agente.handoffEnabled,
        timeDoChatwoot: agente.handoffTeamId,
      },
      gatilhoHttp: detalhes.trigger
        ? {
            ligado: detalhes.trigger.enabled,
            pausadoAutomaticamente: detalhes.trigger.pausadoAutomaticamenteMotivo
              ? {
                  em: quando(detalhes.trigger.pausadoAutomaticamenteEm),
                  motivo: detalhes.trigger.pausadoAutomaticamenteMotivo,
                }
              : null,
          }
        : "não gerado",
      agendamentos: detalhes.schedules.map((s) => ({
        id: s.id,
        nome: s.nome,
        cron: s.cron,
        ligado: s.enabled,
      })),
      dono: detalhes.owner?.name ?? null,
      ultimaAlteracao: {
        por: detalhes.updatedBy?.name ?? null,
        em: quando(agente.updatedAt),
      },
      links: {
        painel: `${ctx.baseUrl}/agentes/${agente.id}`,
        mesa: `${ctx.baseUrl}/mesa/${agente.key}`,
      },
    });
  },
});

const verRegrasInjetadas = ferramenta({
  name: "ver_regras_injetadas",
  title: "Ver regras injetadas",
  description:
    "Mostra o que o sistema soma ao prompt do agente em todo turno — as Regras da Casa (que vencem o prompt em conflito) e a lista de colegas para quem ele pode transferir — exatamente como o agente recebe, calculado pela mesma função do turno. A cauda das regras muda com a origem do turno. Use antes de reescrever um prompt, para não escrever nada que as contradiga.",
  papel: UserRole.VIEWER,
  anotacoes: CONSULTA,
  entrada: z.strictObject({
    agente: campoAgente,
    origem: z
      .enum(RunSource)
      .optional()
      .describe(
        "De onde vem o turno: CHATWOOT (padrão), PLAYGROUND, TRIGGER, SCHEDULE ou MESA.",
      ),
    caixa: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Id da caixa de entrada do Chatwoot. Filtra os colegas como no atendimento real; sem ela, aparecem todos.",
      ),
    incluirPromptCompleto: z
      .boolean()
      .optional()
      .describe("Padrão falso. Verdadeiro devolve também o texto final concatenado."),
  }),
  async executar({ agente: termo, origem, caixa, incluirPromptCompleto }) {
    const agente = await acharAgente(termo);
    if (!agente) return agenteNaoEncontrado(termo);

    const fonte = origem ?? RunSource.CHATWOOT;
    const contexto = await prepararContexto(agente, fonte, caixa ?? null);

    return responder({
      agente: agente.key,
      origem: `${fonte} (${ROTULO_DA_FONTE[fonte]})`,
      ordem:
        "prompt do operador → Regras da Casa → colegas. As regras falam das 'instruções acima', que são o prompt do operador.",
      observacao:
        "Repetir uma regra no prompt não quebra nada — manter as regras visíveis no campo de prompt é decisão da casa. Contradizê-las, sim: em conflito, o bloco injetado vence.",
      tokensAproximados: {
        promptDoOperador: tokensAproximados(contexto.partes.operador),
        regrasDaCasa: tokensAproximados(contexto.partes.conduta),
        colegas: tokensAproximados(contexto.partes.colegas),
      },
      regrasDaCasa: contexto.partes.conduta.trim(),
      colegas: contexto.partes.colegas.trim() || null,
      ...(incluirPromptCompleto ? { promptCompleto: contexto.systemPrompt } : {}),
    });
  },
});

const verFerramenta = ferramenta({
  name: "ver_ferramenta",
  title: "Ver ferramenta",
  description:
    "Descrição e parâmetros exatos (JSON Schema) de uma ferramenta que os agentes usam, se ela escreve em sistema externo, quanto pesa no prompt e quais agentes a têm liberada. Use para escrever prompt com os nomes de parâmetro certos: nome diferente é descartado em silêncio quando o agente chama a ferramenta.",
  papel: UserRole.VIEWER,
  anotacoes: CONSULTA,
  entrada: z.strictObject({
    nome: z
      .string()
      .trim()
      .min(1)
      .describe("Nome exato, ex.: clickup_criar_tarefa."),
  }),
  async executar({ nome }) {
    const achada = localizarFerramenta(nome);
    if (!achada) {
      const todas = [...nomesDoCatalogo()].sort();
      const prefixo = `${nome.split("_")[0]}_`;
      const parecidas = todas.filter((n) => n.startsWith(prefixo));
      return recusar(`Não existe ferramenta "${nome}".`, {
        ferramentas: parecidas.length > 0 ? parecidas : todas,
      });
    }

    const { definicao, integracao } = achada;
    const parametros = z.toJSONSchema(definicao.inputSchema, {
      io: "input",
    }) as Record<string, unknown>;
    delete parametros.$schema;

    const [registro, vinculos] = await Promise.all([
      db.integration.findUnique({
        where: { provider: integracao.provider },
        select: { enabled: true },
      }),
      db.agentIntegration.findMany({
        where: {
          enabled: true,
          integration: { provider: integracao.provider },
          agent: { archivedAt: null },
        },
        select: {
          allowedTools: true,
          agent: { select: { key: true, name: true, active: true } },
        },
      }),
    ]);

    return responder({
      nome: definicao.name,
      integracao: integracao.provider,
      categoria: definicao.categoria ?? null,
      escreveEmSistemaExterno: Boolean(definicao.requiresConfirmation),
      tokensPorMensagem: tokensAproximadosDaTool(definicao),
      descricao: definicao.description,
      parametros,
      atencao:
        "Parâmetro com nome fora de 'parametros' é descartado em silêncio quando o agente chama a ferramenta: a chamada 'dá certo' sem aplicar aquilo. No prompt, use exatamente estes nomes.",
      integracaoLigadaGlobalmente: registro?.enabled ?? false,
      agentesComElaLiberada: vinculos
        .filter(
          (v) =>
            v.allowedTools.length === 0 ||
            v.allowedTools.includes(definicao.name),
        )
        .map((v) => ({
          key: v.agent.key,
          nome: v.agent.name,
          agenteLigado: v.agent.active,
        })),
    });
  },
});

const listarIntegracoesMcp = ferramenta({
  name: "listar_integracoes",
  title: "Listar integrações",
  description:
    "Lista as integrações (Chatwoot, ClickUp, Conexa, ZapSign, OpenAI/leitura de mídia, Documentos, Google) com o toggle global, se há credencial cadastrada (sim ou não — o conteúdo nunca), o último teste de conexão e quais agentes as têm ligadas.",
  papel: UserRole.VIEWER,
  anotacoes: CONSULTA,
  entrada: z.strictObject({}),
  async executar() {
    const registros = await db.integration.findMany({
      select: {
        provider: true,
        enabled: true,
        status: true,
        lastCheckedAt: true,
        lastError: true,
        credential: { select: { rotatedAt: true } },
        agents: {
          where: { enabled: true, agent: { archivedAt: null } },
          select: { agent: { select: { key: true } } },
        },
      },
    });

    return responder({
      integracoes: listarIntegracoes().map((definicao) => {
        const r = registros.find((x) => x.provider === definicao.provider);
        return {
          provider: definicao.provider,
          nome: definicao.label,
          descricao: definicao.descricao,
          configurada: Boolean(r),
          ligadaGlobalmente: r?.enabled ?? false,
          credencial: definicao.credentialLabel
            ? r?.credential
              ? "cadastrada"
              : "falta cadastrar (só o Proprietário, pelo painel)"
            : "não usa",
          ultimoTeste: r?.lastCheckedAt
            ? { em: quando(r.lastCheckedAt), status: r.status, erro: r.lastError }
            : null,
          ferramentas: definicao.tools.length,
          agentesComElaLigada: r?.agents.map((v) => v.agent.key) ?? [],
        };
      }),
    });
  },
});

const verIntegracao = ferramenta({
  name: "ver_integracao",
  title: "Ver integração",
  description:
    "Detalhe de uma integração: configuração não sensível, ferramentas (nome, categoria, se escreve, peso no prompt) e o estado dela em cada agente — ligada ou não e quais ferramentas liberadas. Credenciais nunca aparecem.",
  papel: UserRole.VIEWER,
  anotacoes: CONSULTA,
  entrada: z.strictObject({ provider: z.enum(IntegrationProvider) }),
  async executar({ provider }) {
    const definicao = obterIntegracao(provider);
    if (!definicao) return recusar("Esta integração não tem implementação no sistema.");

    const [registro, agentes] = await Promise.all([
      db.integration.findUnique({
        where: { provider },
        select: {
          enabled: true,
          config: true,
          status: true,
          lastCheckedAt: true,
          lastError: true,
          credential: { select: { rotatedAt: true } },
        },
      }),
      db.agent.findMany({
        where: { archivedAt: null },
        orderBy: { name: "asc" },
        select: {
          key: true,
          name: true,
          active: true,
          integrations: {
            where: { integration: { provider } },
            select: { enabled: true, allowedTools: true },
          },
        },
      }),
    ]);

    return responder({
      provider,
      nome: definicao.label,
      descricao: definicao.descricao,
      configurada: Boolean(registro),
      ligadaGlobalmente: registro?.enabled ?? false,
      credencial: definicao.credentialLabel
        ? registro?.credential
          ? `cadastrada (trocada em ${quando(registro.credential.rotatedAt)})`
          : "falta cadastrar (só o Proprietário, pelo painel)"
        : "não usa",
      configuracao: registro ? semSegredos(registro.config) : null,
      ultimoTeste: registro?.lastCheckedAt
        ? {
            em: quando(registro.lastCheckedAt),
            status: registro.status,
            erro: registro.lastError,
          }
        : null,
      ferramentas: definicao.tools.map((t) => ({
        nome: t.name,
        categoria: t.categoria ?? null,
        escreve: Boolean(t.requiresConfirmation),
        tokens: tokensAproximadosDaTool(t),
      })),
      porAgente: agentes.map((a) => {
        const vinculo = a.integrations[0];
        return {
          key: a.key,
          nome: a.name,
          agenteLigado: a.active,
          ligadaNoAgente: vinculo?.enabled ?? false,
          liberadas:
            vinculo && vinculo.allowedTools.length > 0
              ? vinculo.allowedTools
              : "todas",
        };
      }),
    });
  },
});

const listarExecucoes = ferramenta({
  name: "listar_execucoes",
  title: "Listar execuções",
  description:
    "Execuções recentes (cada turno de um agente), da mais nova para a mais antiga: status, origem, modelo, custo, tokens, ferramentas chamadas e o começo da entrada, da resposta e do erro. Para o conteúdo inteiro de uma, use ver_execucao.",
  papel: UserRole.VIEWER,
  anotacoes: CONSULTA,
  entrada: z.strictObject({
    agente: campoAgente.optional(),
    status: z.enum(RunStatus).optional(),
    origem: z.enum(RunSource).optional(),
    periodo: z.enum(PERIODOS_DO_MCP).optional().describe("Padrão: qualquer data."),
    limite: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Padrão 20, máximo 100."),
  }),
  async executar({ agente: termo, status, origem, periodo, limite }) {
    let agentId: string | null = null;
    if (termo) {
      const agente = await acharAgente(termo);
      if (!agente) return agenteNaoEncontrado(termo);
      agentId = agente.id;
    }

    const execucoes = await db.agentRun.findMany({
      where: {
        ...montarWhere({
          intervalo: intervaloDoPeriodo(periodo ?? "tudo"),
          agentId,
          model: null,
          source: origem ?? null,
        }),
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limite ?? 20,
      // ⚠ Select explícito: sem ele viria `messages`, a conversa inteira
      // mandada ao modelo — megabytes por linha.
      select: {
        id: true,
        status: true,
        source: true,
        model: true,
        createdAt: true,
        latencyMs: true,
        costUsd: true,
        inputTokens: true,
        outputTokens: true,
        input: true,
        output: true,
        error: true,
        agent: { select: { key: true } },
        conversation: { select: { chatwootConversationId: true } },
        toolCalls: {
          orderBy: { createdAt: "asc" },
          select: { toolName: true, isError: true },
        },
      },
    });

    return responder({
      quantidade: execucoes.length,
      execucoes: execucoes.map((e) => ({
        id: e.id,
        agente: e.agent.key,
        status: e.status,
        origem: e.source,
        modelo: e.model,
        em: quando(e.createdAt),
        latenciaMs: e.latencyMs,
        custoUsd: arredondarUsd(Number(e.costUsd ?? 0)),
        tokens: { entrada: e.inputTokens, saida: e.outputTokens },
        conversaNoChatwoot: e.conversation?.chatwootConversationId ?? null,
        entrada: recortarTexto(e.input, 280),
        resposta: recortarTexto(e.output, 280),
        erro: recortarTexto(e.error, 400),
        ferramentas: e.toolCalls.map((t) =>
          t.isError ? `${t.toolName} (erro)` : t.toolName,
        ),
      })),
    });
  },
});

const verExecucao = ferramenta({
  name: "ver_execucao",
  title: "Ver execução",
  description:
    "Uma execução inteira: entrada, resposta, erro, e cada ferramenta chamada com os parâmetros que recebeu e o que devolveu — é o que responde 'por que o agente fez isso?'. Blocos muito grandes vêm cortados, e o corte é dito.",
  papel: UserRole.VIEWER,
  anotacoes: CONSULTA,
  entrada: z.strictObject({
    id: z.string().trim().min(1),
    incluirTranscricao: z
      .boolean()
      .optional()
      .describe(
        "Padrão falso. A transcrição enviada ao modelo repete o system prompt inteiro e costuma ser longa.",
      ),
  }),
  async executar({ id, incluirTranscricao }) {
    const [resumo, detalhe] = await Promise.all([
      db.agentRun.findUnique({
        where: { id },
        select: {
          status: true,
          source: true,
          model: true,
          createdAt: true,
          latencyMs: true,
          costUsd: true,
          agent: { select: { key: true, name: true } },
        },
      }),
      lerDetalheDaExecucao(id),
    ]);
    if (!resumo || !detalhe) return recusar("Execução não encontrada.");

    const houveCorte =
      detalhe.transcricaoCortada ||
      detalhe.omitidas.toolCalls > 0 ||
      detalhe.omitidas.mensagens > 0;

    return responder({
      id,
      agente: { key: resumo.agent.key, nome: resumo.agent.name },
      status: resumo.status,
      origem: resumo.source,
      modelo: resumo.model,
      em: quando(resumo.createdAt),
      terminouEm: quando(detalhe.finishedAt),
      latenciaMs: resumo.latencyMs,
      custoUsd: arredondarUsd(Number(resumo.costUsd ?? 0)),
      iteracoes: detalhe.iterations,
      tokens: {
        entrada: detalhe.inputTokens,
        saida: detalhe.outputTokens,
        lidosDoCache: detalhe.cacheReadTokens,
      },
      conversa: detalhe.conversa
        ? {
            noChatwoot: detalhe.conversa.chatwootConversationId,
            contato: detalhe.conversa.contactName,
          }
        : null,
      entrada: detalhe.input,
      resposta: detalhe.output,
      erro: detalhe.error,
      ferramentas: detalhe.toolCalls.map((t) => ({
        nome: t.toolName,
        erro: t.isError,
        duracaoMs: t.durationMs,
        parametros: t.input,
        retorno: t.output,
      })),
      ...(incluirTranscricao ? { transcricao: detalhe.mensagens } : {}),
      cortes: houveCorte
        ? {
            algumBlocoCortado: detalhe.transcricaoCortada,
            deixadasDeFora: detalhe.omitidas,
          }
        : null,
    });
  },
});

const listarVersoes = ferramenta({
  name: "listar_versoes",
  title: "Listar versões do prompt",
  description:
    "Histórico de versões de um agente (uma nova a cada mudança de prompt, modelo ou effort), da mais nova para a mais antiga, com quem fez, quando, a nota e qual está vigente.",
  papel: UserRole.VIEWER,
  anotacoes: CONSULTA,
  entrada: z.strictObject({
    agente: campoAgente,
    limite: z.number().int().min(1).max(50).optional().describe("Padrão 20."),
  }),
  async executar({ agente: termo, limite }) {
    const agente = await acharAgente(termo);
    if (!agente) return agenteNaoEncontrado(termo);

    const versoes = await db.agentVersion.findMany({
      where: { agentId: agente.id },
      orderBy: { version: "desc" },
      take: limite ?? 20,
      select: {
        version: true,
        model: true,
        effort: true,
        note: true,
        createdAt: true,
        systemPrompt: true,
        createdBy: { select: { name: true } },
      },
    });

    return responder({
      agente: agente.key,
      versoes: versoes.map((v) => ({
        versao: v.version,
        modelo: v.model,
        effort: v.effort,
        nota: v.note,
        por: v.createdBy?.name ?? null,
        em: quando(v.createdAt),
        caracteres: v.systemPrompt.length,
        vigente:
          v.systemPrompt === agente.systemPrompt &&
          v.model === agente.model &&
          v.effort === agente.effort,
      })),
    });
  },
});

const verVersao = ferramenta({
  name: "ver_versao",
  title: "Ver versão do prompt",
  description:
    'O prompt de uma versão antiga, e opcionalmente o diff dela contra outra versão ou contra o prompt atual. Para voltar a uma versão, use propor_alteracao_de_prompt com novoPrompt igual ao texto dela — com compararCom "atual", o diff aqui já é o que mudaria.',
  papel: UserRole.VIEWER,
  anotacoes: CONSULTA,
  entrada: z.strictObject({
    agente: campoAgente,
    versao: z.number().int().min(1),
    compararCom: z
      .union([z.number().int().min(1), z.literal("atual")])
      .optional()
      .describe(
        'Outra versão, ou "atual". O diff vai de compararCom (antes) para versao (depois).',
      ),
  }),
  async executar({ agente: termo, versao, compararCom }) {
    const agente = await acharAgente(termo);
    if (!agente) return agenteNaoEncontrado(termo);

    const buscar = (numero: number) =>
      db.agentVersion.findUnique({
        where: { agentId_version: { agentId: agente.id, version: numero } },
        select: {
          version: true,
          model: true,
          effort: true,
          note: true,
          createdAt: true,
          systemPrompt: true,
          createdBy: { select: { name: true } },
        },
      });

    const alvo = await buscar(versao);
    if (!alvo) return recusar(`O agente ${agente.key} não tem a versão ${versao}.`);

    let comparacao = null;
    if (compararCom !== undefined) {
      let antes: string;
      let rotulo: string;
      if (compararCom === "atual") {
        antes = agente.systemPrompt;
        rotulo = "prompt atual";
      } else {
        const outra = await buscar(compararCom);
        if (!outra) {
          return recusar(`O agente ${agente.key} não tem a versão ${compararCom}.`);
        }
        antes = outra.systemPrompt;
        rotulo = `versão ${compararCom}`;
      }
      const linhas = diffPorLinha(
        normalizarQuebras(antes),
        normalizarQuebras(alvo.systemPrompt),
      );
      comparacao = {
        de: rotulo,
        para: `versão ${versao}`,
        ...contarMudancas(linhas),
        diff: formatarDiff(linhas) || "(nenhuma diferença)",
      };
    }

    return responder({
      agente: agente.key,
      versao: alvo.version,
      modelo: alvo.model,
      effort: alvo.effort,
      nota: alvo.note,
      por: alvo.createdBy?.name ?? null,
      em: quando(alvo.createdAt),
      comparacao,
      prompt: alvo.systemPrompt,
    });
  },
});

const listarAgendamentos = ferramenta({
  name: "listar_agendamentos",
  title: "Listar agendamentos",
  description:
    "Agendamentos (o agente roda sozinho na hora marcada, sem cliente): frequência, instrução, se está ligado, as próximas execuções no horário de São Paulo, o último resultado e pausas automáticas por falha. Agendamento não fala no WhatsApp — só age pelas ferramentas do agente.",
  papel: UserRole.VIEWER,
  anotacoes: CONSULTA,
  entrada: z.strictObject({ agente: campoAgente.optional() }),
  async executar({ agente: termo }) {
    let agentId: string | undefined;
    if (termo) {
      const agente = await acharAgente(termo);
      if (!agente) return agenteNaoEncontrado(termo);
      agentId = agente.id;
    }

    const linhas = await db.agentSchedule.findMany({
      where: agentId ? { agentId } : {},
      orderBy: [{ agentId: "asc" }, { createdAt: "asc" }],
      include: {
        agent: { select: { key: true, active: true, archivedAt: true } },
      },
    });

    return responder({
      quantidade: linhas.length,
      agendamentos: linhas.map((l) => {
        const leitura = lerCron(l.cron, 3);
        return {
          id: l.id,
          agente: l.agent.key,
          agenteAtivo: l.agent.active && !l.agent.archivedAt,
          nome: l.nome,
          cron: l.cron,
          instrucao: l.instrucao,
          ligado: l.enabled,
          toleranciaMinutos: l.toleranciaMinutos,
          proximas:
            leitura.valida && l.enabled ? leitura.proximas.map((d) => quando(d)) : [],
          erroNaFrequencia: leitura.valida ? null : leitura.erro,
          ultimaExecucao: l.ultimaExecucaoEm
            ? {
                em: quando(l.ultimaExecucaoEm),
                resultado: l.ultimoResultado,
                detalhe: l.ultimoDetalhe,
              }
            : null,
          falhasConsecutivas: l.falhasConsecutivas,
          pausadoAutomaticamente: l.pausadoAutomaticamenteMotivo
            ? {
                em: quando(l.pausadoAutomaticamenteEm),
                motivo: l.pausadoAutomaticamenteMotivo,
              }
            : null,
        };
      }),
    });
  },
});

const resumoDeConsumo = ferramenta({
  name: "resumo_de_consumo",
  title: "Resumo de consumo",
  description:
    "Quanto os agentes custaram num período, por agente, por modelo e por origem — o custo real cobrado pela OpenRouter, em dólar, conferível com a fatura. Não inclui a leitura de mídia (OpenAI, fatura separada). Execuções com erro continuam no custo.",
  papel: UserRole.VIEWER,
  anotacoes: CONSULTA,
  entrada: z.strictObject({
    periodo: z.enum(PERIODOS_DO_MCP).optional().describe("Padrão 30d."),
    agente: campoAgente.optional(),
    origem: z.enum(RunSource).optional(),
    porDia: z
      .boolean()
      .optional()
      .describe("Padrão falso. Verdadeiro inclui a série diária."),
  }),
  async executar({ periodo, agente: termo, origem, porDia }) {
    let agentId: string | null = null;
    if (termo) {
      const agente = await acharAgente(termo);
      if (!agente) return agenteNaoEncontrado(termo);
      agentId = agente.id;
    }

    const intervalo = intervaloDoPeriodo(periodo ?? "30d");
    const resultado = await varrerPeriodo({
      intervalo,
      agentId,
      model: null,
      source: origem ?? null,
    });

    // Total pela metade que parece certo é o pior desfecho numa apuração.
    if (resultado.excedeu) {
      return recusar(
        `O período tem ${resultado.total} execuções, acima do teto de ${TETO_DE_LINHAS} que a apuração soma de uma vez. Escolha um período menor ou filtre por agente.`,
      );
    }

    const { linhas } = resultado;
    const primeiroDia = linhas[0] ? diaEmSaoPaulo(linhas[0].createdAt) : null;
    const apuracao = agregar(
      linhas,
      porDia ? diasDoIntervalo(intervalo, primeiroDia) : [],
    );

    const chaves = new Map(
      (await db.agent.findMany({ select: { id: true, key: true } })).map((a) => [
        a.id,
        a.key,
      ]),
    );

    const fatia = (rotular: (chave: string) => string) => (f: Fatia) => ({
      nome: rotular(f.chave),
      custoUsd: arredondarUsd(f.custoUsd),
      parcela: `${(f.parcela * 100).toFixed(1)}%`,
      execucoes: f.execucoes,
      erros: f.erros,
      tokens: f.tokens,
    });

    const t = apuracao.totais;
    return responder({
      periodo: intervalo.rotulo,
      totais: {
        custoUsd: arredondarUsd(t.custoUsd),
        execucoes: t.execucoes,
        erros: t.erros,
        atendimentos: t.conversas,
        custoPorAtendimentoUsd:
          t.custoPorConversa == null ? null : arredondarUsd(t.custoPorConversa),
        custoMedioPorExecucaoUsd: arredondarUsd(t.custoMedioPorExecucao),
        tokens: {
          entrada: t.tokensEntrada,
          saida: t.tokensSaida,
          lidosDoCache: t.tokensCache,
        },
        latenciaMediaMs: t.latenciaMediaMs,
      },
      porAgente: apuracao.porAgente.map(
        fatia((chave) => chaves.get(chave) ?? "agente excluído"),
      ),
      porModelo: apuracao.porModelo.map(
        fatia((chave) => (chave === SEM_MODELO ? "sem modelo registrado" : chave)),
      ),
      porOrigem: apuracao.porFonte.map(
        fatia((chave) => ROTULO_DA_FONTE[chave as RunSource] ?? chave),
      ),
      ...(porDia ? { porDia: apuracao.porDia } : {}),
    });
  },
});

export const FERRAMENTAS_DE_LEITURA: FerramentaMcp[] = [
  listarAgentes,
  verAgente,
  verRegrasInjetadas,
  verFerramenta,
  listarIntegracoesMcp,
  verIntegracao,
  listarExecucoes,
  verExecucao,
  listarVersoes,
  verVersao,
  listarAgendamentos,
  resumoDeConsumo,
];
