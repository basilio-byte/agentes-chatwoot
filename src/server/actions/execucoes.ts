"use server";

import { db } from "@/lib/db";
import { exigirSessao } from "@/server/auth-guard";
import { lerTranscricao, recortar } from "@/server/execucoes/trace";
import type { MensagemDoTrace } from "@/server/execucoes/trace";

/**
 * Detalhe completo de uma execução, buscado **sob demanda** quando alguém
 * expande o cartão.
 *
 * Não vem junto da lista de propósito: `AgentRun.messages` guarda a conversa
 * inteira mandada ao modelo, e um turno longo passa de um megabyte sozinho.
 * Cinquenta desses na primeira pintura tornariam a lista inutilizável para ver
 * o que ela existe para mostrar.
 */

export type ToolCallDetalhada = {
  id: string;
  toolName: string;
  provider: string | null;
  isError: boolean;
  durationMs: number | null;
  createdAt: Date;
  input: string;
  output: string;
};

export type DetalheDaExecucao = {
  id: string;
  input: string;
  output: string | null;
  error: string | null;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  finishedAt: Date | null;
  toolCalls: ToolCallDetalhada[];
  mensagens: MensagemDoTrace[];
  /** Algum bloco foi cortado por tamanho — a tela avisa. */
  transcricaoCortada: boolean;
  conversa: {
    id: string;
    chatwootConversationId: number;
    contactName: string | null;
  } | null;
};

export async function detalharExecucao(
  id: string,
): Promise<DetalheDaExecucao | null> {
  // Mesmo tier da tela que lista: quem enxerga a lista pode abrir o item dela.
  await exigirSessao();

  const run = await db.agentRun.findUnique({
    where: { id },
    select: {
      id: true,
      input: true,
      output: true,
      error: true,
      iterations: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      finishedAt: true,
      messages: true,
      toolCalls: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          toolName: true,
          provider: true,
          isError: true,
          durationMs: true,
          createdAt: true,
          input: true,
          output: true,
        },
      },
      conversation: {
        select: {
          id: true,
          chatwootConversationId: true,
          contactName: true,
        },
      },
    },
  });

  if (!run) return null;

  const transcricao = lerTranscricao(run.messages);
  let cortou = transcricao.cortada;

  const toolCalls = run.toolCalls.map((t) => {
    const entrada = recortar(t.input);
    const saida = recortar(t.output);
    if (entrada.cortado || saida.cortado) cortou = true;
    return {
      id: t.id,
      toolName: t.toolName,
      provider: t.provider,
      isError: t.isError,
      durationMs: t.durationMs,
      createdAt: t.createdAt,
      input: entrada.texto,
      output: saida.texto,
    };
  });

  return {
    id: run.id,
    input: run.input,
    output: run.output,
    error: run.error,
    iterations: run.iterations,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadTokens: run.cacheReadTokens,
    finishedAt: run.finishedAt,
    conversa: run.conversation,
    transcricaoCortada: cortou,
    mensagens: transcricao.mensagens,
    toolCalls,
  };
}
