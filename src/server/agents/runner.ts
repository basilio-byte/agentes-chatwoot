import type OpenAI from "openai";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getOpenRouter } from "./openrouter";
import { estimarCusto, obterModelo, type UsoTokens } from "./catalogo";
import {
  paraFerramentasOpenAI,
  resolverToolsDoAgente,
  type ToolResolvida,
} from "@/server/integrations/resolve";
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

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: agente.systemPrompt },
    ...(entrada.historico ?? []).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { role: "user" as const, content: entrada.mensagem },
  ];

  const run = await db.agentRun.create({
    data: {
      agentId: agente.id,
      conversationId: entrada.conversationId,
      source: entrada.source,
      status: RunStatus.RUNNING,
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
        max_tokens: agente.maxTokens,
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

      const retorno = await cliente.chat.completions.create(parametros);

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
            registro: toolCalls,
          }),
        ),
      );
      messages.push(...resultados);
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

    return {
      runId: run.id,
      resposta,
      iteracoes,
      atingiuLimiteDeIteracoes: atingiuLimite,
      toolCalls,
      uso,
      custoUsd,
      latenciaMs,
    };
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    logger.error({ runId: run.id, erro: mensagem }, "falha ao executar agente");

    await db.agentRun.update({
      where: { id: run.id },
      data: {
        status: RunStatus.ERROR,
        error: mensagem,
        messages: JSON.parse(JSON.stringify(messages)),
        ...uso,
        latencyMs: Date.now() - inicio,
        iterations: iteracoes,
        finishedAt: new Date(),
      },
    });

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
