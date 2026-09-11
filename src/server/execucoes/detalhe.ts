import { db } from "@/lib/db";
import { lerTranscricao, recortar } from "./trace";
import { TETO_DO_DETALHE } from "./limites";
import type { MensagemDoTrace } from "./trace";

/**
 * Detalhe completo de uma execução, buscado **sob demanda**.
 *
 * Não vem junto da lista de propósito: `AgentRun.messages` guarda a conversa
 * inteira mandada ao modelo, e um turno longo passa de um megabyte sozinho.
 * Cinquenta desses na primeira pintura tornariam a lista inutilizável para ver
 * o que ela existe para mostrar.
 *
 * Sem checagem de sessão aqui: quem chama confere. O painel exige sessão; o MCP
 * exige token. É a mesma leitura, com o mesmo teto, para as duas portas.
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
  /** Mensagens e chamadas deixadas de fora pelo teto do detalhe inteiro. */
  omitidas: { mensagens: number; toolCalls: number };
  conversa: {
    id: string;
    chatwootConversationId: number;
    contactName: string | null;
  } | null;
};

export async function lerDetalheDaExecucao(
  id: string,
): Promise<DetalheDaExecucao | null> {
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

  // Orçamento compartilhado: as chamadas vêm primeiro porque são o que se olha
  // para entender o que o agente FEZ; a transcrição é material de leitura.
  let orcamento = TETO_DO_DETALHE;

  const toolCalls: ToolCallDetalhada[] = [];
  for (const t of run.toolCalls) {
    const entrada = recortar(t.input);
    const saida = recortar(t.output);
    if (entrada.cortado || saida.cortado) cortou = true;

    const custo = entrada.texto.length + saida.texto.length;
    if (custo > orcamento) break;
    orcamento -= custo;

    toolCalls.push({
      id: t.id,
      toolName: t.toolName,
      provider: t.provider,
      isError: t.isError,
      durationMs: t.durationMs,
      createdAt: t.createdAt,
      input: entrada.texto,
      output: saida.texto,
    });
  }

  const mensagens: typeof transcricao.mensagens = [];
  for (const m of transcricao.mensagens) {
    if (m.conteudo.length > orcamento) break;
    orcamento -= m.conteudo.length;
    mensagens.push(m);
  }

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
    mensagens,
    toolCalls,
    omitidas: {
      mensagens: transcricao.mensagens.length - mensagens.length,
      toolCalls: run.toolCalls.length - toolCalls.length,
    },
  };
}
