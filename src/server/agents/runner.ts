import type OpenAI from "openai";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { mensagemDeContextoTemporal } from "@/lib/tempo";
import { getOpenRouter } from "./openrouter";
import {
  estimarCusto,
  limitarSaida,
  obterModelo,
  type UsoTokens,
} from "./catalogo";
import {
  paraFerramentasOpenAI,
  resolverToolsDoAgente,
  type ToolResolvida,
} from "@/server/integrations/resolve";
import type {
  SinaisDoTurno,
  SinalDeHandoff,
} from "@/server/integrations/types";
import { blocoDeRoster, montarRoster } from "./equipe";
import {
  comParadaVigiada,
  conferirParada,
  ehInterrupcao,
  limparPedido,
} from "./cancelamento";
import { RunSource, RunStatus } from "@/generated/prisma/enums";

export type MensagemHistorico = {
  role: "user" | "assistant";
  content: string;
};

export type EntradaExecucao = {
  agentId: string;
  source: RunSource;
  /** Turnos anteriores, em texto puro. */
  historico?: MensagemHistorico[];
  mensagem: string;
  conversationId?: string;
  chatwootConversationId?: number;
  /** Caixa de entrada da conversa — filtra quem aparece no roster. */
  inboxId?: number | null;
  /** Agente dono do bot pelo qual a conversa entrou. Ver ToolContext.canalAgentId. */
  canalAgentId?: string;
  /**
   * Bastão recebido de outro agente. Entra como mensagem `system` junto do
   * contexto temporal, nunca no systemPrompt — ele muda por conversa e no
   * prefixo destruiria o cache do provedor.
   */
  bastao?: string | null;
};

export type ToolCallRegistrado = {
  nome: string;
  input: unknown;
  output: unknown;
  isError: boolean;
  durationMs: number;
};

export type ResultadoExecucao = {
  runId: string;
  resposta: string;
  iteracoes: number;
  atingiuLimiteDeIteracoes: boolean;
  toolCalls: ToolCallRegistrado[];
  uso: UsoTokens;
  custoUsd: number;
  latenciaMs: number;
  /** Preenchido quando o agente pediu para passar a conversa a um colega. */
  handoff?: SinalDeHandoff;
  /**
   * Uma tool já mandou a mensagem de passagem ao cliente. O worker usa isto
   * para não disparar a resposta de contorno por cima de um turno bem-sucedido.
   */
  avisouCliente?: boolean;
};

const USO_ZERADO: UsoTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** Campos que a OpenRouter aceita além do protocolo padrão de chat completions. */
type ParametrosOpenRouter = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
  usage?: { include: boolean };
  reasoning?: { effort: "low" | "medium" | "high" };
};

/** A OpenRouter devolve o custo real da requisição quando `usage.include` é true. */
type UsoOpenRouter = OpenAI.Completions.CompletionUsage & {
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
};

/**
 * Executa um turno do agente: monta o contexto, roda o loop de tool use e
 * devolve a resposta final, já persistida em `AgentRun` + `ToolCall`.
 *
 * Sem framework de propósito — o loop precisa ser auditável linha a linha para
 * responder "por que o bot respondeu isso?".
 */
export async function executarAgente(
  entrada: EntradaExecucao,
): Promise<ResultadoExecucao> {
  const inicio = Date.now();
  const agente = await db.agent.findUniqueOrThrow({
    where: { id: entrada.agentId },
  });

  const resolvidas = await resolverToolsDoAgente(agente.id);
  const ferramentas = paraFerramentasOpenAI(resolvidas);
  const modelo = await obterModelo(agente.model);

  if (ferramentas.length > 0 && modelo && !modelo.suportaTools) {
    logger.warn(
      { agentId: agente.id, modelo: agente.model },
      "modelo não suporta tools — as integrações do agente serão ignoradas neste turno",
    );
  }
  const enviarFerramentas =
    ferramentas.length > 0 && (modelo?.suportaTools ?? true);

  // O roster vai DENTRO do system prompt porque é estável entre requisições:
  // só muda quando alguém mexe na equipe. Se fosse mensagem, ocuparia posição
  // depois do histórico sem ganho nenhum de cache.
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
      inboxMode: true,
      inboxIds: true,
    },
  });
  const roster = montarRoster(equipe, agente.id, entrada.inboxId);
  const systemPrompt = agente.systemPrompt + blocoDeRoster(roster, agente.name);

  const sinais: SinaisDoTurno = {};

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...(entrada.historico ?? []).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    // Bastão e contexto temporal vão aqui, e não no system prompt, de propósito:
    // mudam a cada requisição e, no início do prompt, invalidariam o cache do
    // provedor em toda mensagem da conversa. No fim, tudo antes deles continua
    // cacheável.
    ...(entrada.bastao
      ? [{ role: "system" as const, content: entrada.bastao }]
      : []),
    { role: "system" as const, content: mensagemDeContextoTemporal() },
    { role: "user" as const, content: entrada.mensagem },
  ];

  const run = await db.agentRun.create({
    data: {
      agentId: agente.id,
      conversationId: entrada.conversationId,
      source: entrada.source,
      status: RunStatus.RUNNING,
      // Congelado aqui, e não lido de `Agent.model` na hora de apurar: o
      // agente troca de modelo, e a fatura de ontem não pode mudar por causa
      // disso. Gravado na criação para valer também quando o turno falha.
      model: agente.model,
      input: entrada.mensagem,
    },
  });

  const uso: UsoTokens = { ...USO_ZERADO };
  const toolCalls: ToolCallRegistrado[] = [];
  let iteracoes = 0;
  let resposta = "";
  let custoRelatado: number | null = null;
  let atingiuLimite = false;

  try {
    const cliente = getOpenRouter();

    while (true) {
      // Ponto de parada entre etapas: pega quem mandou parar durante uma tool.
      await conferirParada(run.id);

      if (iteracoes >= agente.maxToolIterations) {
        atingiuLimite = true;
        logger.warn(
          {
            runId: run.id,
            agentId: agente.id,
            limite: agente.maxToolIterations,
          },
          "limite de iterações de tool atingido",
        );
        break;
      }
      iteracoes++;

      const parametros: ParametrosOpenRouter = {
        model: agente.model,
        // Cortado pelo limite real do modelo: o padrão é alto para dar folga a
        // um turno com transferências e tools, mas pedir mais do que o modelo
        // aceita é 400 em vários provedores.
        max_tokens: limitarSaida(agente.maxTokens, modelo),
        messages,
        ...(enviarFerramentas ? { tools: ferramentas } : {}),
        // Faz a OpenRouter devolver o custo real da chamada em `usage.cost`.
        usage: { include: true },
        // `effort` só existe em modelo com raciocínio; mandar para os outros é
        // erro de parâmetro em alguns provedores.
        ...(agente.effort !== "none" && (modelo?.suportaReasoning ?? false)
          ? {
              reasoning: {
                effort: agente.effort as "low" | "medium" | "high",
              },
            }
          : {}),
      };

      // Vigiada porque é aqui que o turno passa quase todo o tempo: parar só
      // entre iterações nunca alcançaria um turno pendurado, que é justamente o
      // que alguém quer matar.
      const retorno = await comParadaVigiada(run.id, (signal) =>
        cliente.chat.completions.create(parametros, { signal }),
      );

      const usoRetorno = retorno.usage as UsoOpenRouter | undefined;
      acumularUso(uso, usoRetorno);
      if (typeof usoRetorno?.cost === "number") {
        custoRelatado = (custoRelatado ?? 0) + usoRetorno.cost;
      }

      const escolha = retorno.choices?.[0];
      if (!escolha) {
        throw new Error(
          "A OpenRouter não retornou nenhuma resposta (choices vazio).",
        );
      }

      const texto = escolha.message.content?.trim();
      if (texto) resposta = texto;

      const pedidos = escolha.message.tool_calls ?? [];
      if (pedidos.length === 0) {
        if (escolha.finish_reason === "length") {
          logger.warn(
            { runId: run.id, maxTokens: agente.maxTokens },
            "resposta truncada por max_tokens",
          );
        }
        break;
      }

      messages.push(escolha.message);

      // No protocolo de chat completions cada tool_call devolve a SUA mensagem
      // `role: "tool"` — diferente do formato da Anthropic, que agrupava tudo
      // numa mensagem só.
      const resultados = await Promise.all(
        pedidos.map((pedido) =>
          executarTool({
            pedido,
            resolvidas,
            runId: run.id,
            agentId: agente.id,
            conversationId: entrada.conversationId,
            chatwootConversationId: entrada.chatwootConversationId,
            canalAgentId: entrada.canalAgentId,
            sinais,
            registro: toolCalls,
          }),
        ),
      );
      messages.push(...resultados);

      // Transferir encerra o turno deste agente: o que ele escrevesse depois
      // seria falado por quem já não é mais o responsável pela conversa.
      if (sinais.handoff) break;
    }

    const custoUsd = custoRelatado ?? estimarCusto(modelo, uso);
    const latenciaMs = Date.now() - inicio;

    await db.agentRun.update({
      where: { id: run.id },
      data: {
        status: RunStatus.SUCCESS,
        output: resposta,
        messages: JSON.parse(JSON.stringify(messages)),
        ...uso,
        costUsd: custoUsd,
        latencyMs: latenciaMs,
        iterations: iteracoes,
        finishedAt: new Date(),
      },
    });

    // Pedido que chegou tarde demais não pode ficar valendo para nada.
    await limparPedido(run.id);

    return {
      runId: run.id,
      resposta,
      iteracoes,
      atingiuLimiteDeIteracoes: atingiuLimite,
      toolCalls,
      uso,
      custoUsd,
      latenciaMs,
      handoff: sinais.handoff,
      avisouCliente: sinais.avisouCliente ?? false,
    };
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    const interrompida = ehInterrupcao(erro);

    // Parada deliberada não é falha, e registrar como falha faria o operador
    // caçar um defeito que ele mesmo causou. O que foi gasto até aqui continua
    // gravado: a OpenRouter cobra pelo que rodou antes do corte.
    if (interrompida) {
      logger.warn(
        { runId: run.id, porQuem: erro.porQuem },
        "execução interrompida no painel",
      );
      await limparPedido(run.id);
    } else {
      logger.error({ runId: run.id, erro: mensagem }, "falha ao executar agente");
    }

    await db.agentRun.update({
      where: { id: run.id },
      data: {
        status: interrompida ? RunStatus.CANCELED : RunStatus.ERROR,
        error: mensagem,
        messages: JSON.parse(JSON.stringify(messages)),
        ...uso,
        latencyMs: Date.now() - inicio,
        iterations: iteracoes,
        finishedAt: new Date(),
      },
    });

    // Anota o runId no erro antes de relançar: é o que permite a quem chama
    // (o worker do gatilho HTTP) saber se alguma ToolCall já foi persistida
    // antes da falha — e portanto se um efeito colateral já aconteceu num
    // sistema externo. Aditivo: quem já chama executarAgente e não lê essa
    // propriedade (Chatwoot, Playground) não é afetado.
    if (erro instanceof Error) {
      (erro as Error & { runId?: string }).runId = run.id;
    }

    throw erro;
  }
}

function acumularUso(uso: UsoTokens, usage: UsoOpenRouter | undefined) {
  if (!usage) return;
  uso.inputTokens += usage.prompt_tokens ?? 0;
  uso.outputTokens += usage.completion_tokens ?? 0;
  uso.cacheReadTokens += usage.prompt_tokens_details?.cached_tokens ?? 0;
}

async function executarTool(args: {
  pedido: OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
  resolvidas: Map<string, ToolResolvida>;
  runId: string;
  agentId: string;
  conversationId?: string;
  chatwootConversationId?: number;
  canalAgentId?: string;
  sinais: SinaisDoTurno;
  registro: ToolCallRegistrado[];
}): Promise<OpenAI.Chat.Completions.ChatCompletionToolMessageParam> {
  const { pedido, resolvidas, runId, registro } = args;
  const comeco = Date.now();

  // Tools customizadas da OpenAI (type !== "function") não são geradas por nós.
  if (pedido.type !== "function") {
    return {
      role: "tool",
      tool_call_id: pedido.id,
      content: "Tipo de tool não suportado.",
    };
  }

  const nome = pedido.function.name;
  const resolvida = resolvidas.get(nome);

  if (!resolvida) {
    return finalizar({
      saida: `Tool "${nome}" não está disponível para este agente.`,
      isError: true,
      input: pedido.function.arguments,
    });
  }

  // Os argumentos vêm como string JSON — e modelos erram esse JSON.
  let bruto: unknown;
  try {
    bruto = pedido.function.arguments
      ? JSON.parse(pedido.function.arguments)
      : {};
  } catch {
    return finalizar({
      saida: "Os argumentos não são um JSON válido. Reenvie a chamada.",
      isError: true,
      input: pedido.function.arguments,
    });
  }

  const validacao = resolvida.definicao.inputSchema.safeParse(bruto);
  if (!validacao.success) {
    return finalizar({
      saida: `Parâmetros inválidos: ${validacao.error.issues
        .map((i) => `${i.path.join(".")} — ${i.message}`)
        .join("; ")}`,
      isError: true,
      input: bruto,
    });
  }

  try {
    const saida = await resolvida.definicao.execute(validacao.data, {
      provider: resolvida.provider,
      config: resolvida.configuracao.config,
      credential: resolvida.configuracao.credential,
      agentId: args.agentId,
      conversationId: args.conversationId,
      chatwootConversationId: args.chatwootConversationId,
      canalAgentId: args.canalAgentId,
      sinais: args.sinais,
    });
    return finalizar({ saida, isError: false, input: validacao.data });
  } catch (erro) {
    // Erro de tool volta como resultado normal — o modelo se ajusta em vez de
    // travar o atendimento.
    return finalizar({
      saida: erro instanceof Error ? erro.message : String(erro),
      isError: true,
      input: validacao.data,
    });
  }

  async function finalizar({
    saida,
    isError,
    input,
  }: {
    saida: unknown;
    isError: boolean;
    input: unknown;
  }): Promise<OpenAI.Chat.Completions.ChatCompletionToolMessageParam> {
    const durationMs = Date.now() - comeco;

    registro.push({ nome, input, output: saida, isError, durationMs });

    await db.toolCall.create({
      data: {
        runId,
        toolName: nome,
        provider: resolvida?.provider,
        input: JSON.parse(JSON.stringify(input ?? null)),
        output: JSON.parse(JSON.stringify(saida ?? null)),
        isError,
        durationMs,
      },
    });

    return {
      role: "tool",
      tool_call_id: pedido.id,
      content: typeof saida === "string" ? saida : JSON.stringify(saida),
    };
  }
}

export { RunSource };
