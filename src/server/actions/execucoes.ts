"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigirPapel, exigirSessao } from "@/server/auth-guard";
import { comFalhaVisivel } from "@/server/actions/falha-visivel";
import { RunSource, RunStatus, UserRole } from "@/generated/prisma/enums";
import { limparPedido, pedirParada } from "@/server/agents/cancelamento";
import { estadoDoWorker } from "@/server/queue/batimento";
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

/**
 * Falha nomeada, em vez de exceção que o Next mascara.
 *
 * ⚠ Em produção o Next entrega ao cliente só o `digest` de um erro de server
 * action — a mensagem real fica no servidor. Se esta ação apenas LANÇASSE, a
 * tela mostraria "não foi possível carregar" para qualquer causa e o log não
 * teria nada. Foi assim que uma falha ao expandir execução passou dias sem
 * diagnóstico, em 09/2026.
 */
export type FalhaAoDetalhar = { erro: string };

export function ehFalhaAoDetalhar(
  r: DetalheDaExecucao | FalhaAoDetalhar | null,
): r is FalhaAoDetalhar {
  return r !== null && "erro" in r;
}

export async function detalharExecucao(
  id: string,
): Promise<DetalheDaExecucao | FalhaAoDetalhar | null> {
  return comFalhaVisivel<DetalheDaExecucao | FalhaAoDetalhar | null>(
    "execucao.detalhar",
    () => detalharExecucaoImpl(id),
    (falha) => ({ erro: falha.erro }),
  );
}

async function detalharExecucaoImpl(
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

/**
 * Idade a partir da qual uma execução `RUNNING` é tratada como zumbi.
 *
 * Turno legítimo não chega perto disso: o vigia já escala a conversa em 3
 * minutos, e o teto de iterações de tool limita o resto. Passou daqui, quem
 * gravou `RUNNING` morreu sem conseguir fechar a linha — e aí não existe
 * ninguém para receber o recado de parada.
 */
export const IDADE_DE_ZUMBI_MS = 10 * 60 * 1000;

export type EstadoDaParada = { ok?: string; erro?: string };

/**
 * Pede para uma execução em andamento parar.
 *
 * Não mata nada de fora: deixa um recado no Redis e quem está rodando o turno
 * o encontra — entre etapas e durante a chamada ao modelo, que é onde o tempo
 * é gasto. O painel roda em outro processo que não o worker, então não há
 * memória compartilhada para tocar.
 *
 * Exige ADMIN: parar um turno interrompe um atendimento com cliente do outro
 * lado, e "Leitura" não muda produção.
 */
export async function pararExecucao(id: string): Promise<EstadoDaParada> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const run = await db.agentRun.findUnique({
    where: { id },
    select: { id: true, status: true, createdAt: true, source: true },
  });
  if (!run) return { erro: "Execução não encontrada." };

  if (run.status !== RunStatus.RUNNING) {
    return { erro: `Esta execução já terminou (${run.status.toLowerCase()}).` };
  }

  const quem = sessao.user.name || sessao.user.email || "painel";
  const registrou = await pedirParada(run.id, quem);

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "run.stop.requested",
      entity: "AgentRun",
      entityId: run.id,
    },
  });

  // Ninguém para receber o recado: o processo que gravou `RUNNING` já morreu, e
  // a linha ficaria "rodando" para sempre, poluindo a lista e o filtro. Fechar
  // aqui é o único jeito — e é seguro justamente porque não há turno vivo.
  const orfa = await ninguemVaiReceber(run);
  if (orfa) {
    await db.agentRun.updateMany({
      // O `status` no where evita a corrida com um turno que estava vivo e
      // terminou entre a leitura acima e esta escrita.
      where: { id: run.id, status: RunStatus.RUNNING },
      data: {
        status: RunStatus.CANCELED,
        error: `Execução encerrada no painel por ${quem} — nenhum processo estava tocando este turno.`,
        finishedAt: new Date(),
      },
    });
    await limparPedido(run.id);

    revalidatePath("/execucoes");
    return {
      ok: "Execução encerrada. Ela estava marcada como rodando, mas nenhum processo a estava tocando.",
    };
  }

  revalidatePath("/execucoes");

  if (!registrou) {
    return {
      erro: "Não consegui falar com o Redis para registrar o pedido. O turno segue rodando.",
    };
  }

  return {
    ok: "Pedido de parada enviado. O agente para na próxima verificação, em alguns segundos.",
  };
}

/**
 * A execução está órfã — sem processo vivo capaz de atender ao pedido?
 *
 * Duas evidências: idade absurda para um turno, ou worker morto. O playground
 * roda no processo do painel, não no worker, então para ele só a idade vale.
 */
async function ninguemVaiReceber(run: {
  createdAt: Date;
  source: RunSource;
}): Promise<boolean> {
  if (Date.now() - run.createdAt.getTime() > IDADE_DE_ZUMBI_MS) return true;
  if (run.source === RunSource.PLAYGROUND) return false;

  const worker = await estadoDoWorker();
  // Indeterminado (Redis fora do ar) não é prova de morte: nesse caso não se
  // fecha nada, para não marcar como encerrado um turno que segue rodando.
  return !worker.vivo && !worker.indeterminado;
}
