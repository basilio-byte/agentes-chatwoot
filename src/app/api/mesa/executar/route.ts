import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { podeEditar } from "@/server/auth-guard";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { RunSource, MediaStatus } from "@/generated/prisma/enums";
import { executarAgente } from "@/server/agents/runner";
import { juntarComAnexos } from "@/server/integrations/openai/formato";
import { consumirFreio, motivoEmPortugues } from "@/server/mesa/freio";

export const runtime = "nodejs";

/**
 * Passo 2 da mesa: o agente roda uma vez sobre o que foi lido.
 *
 * ⚠ **Recebe IDS, nunca o texto.** O conteúdo extraído volta ao servidor pelo
 * banco, e não pelo navegador. Se a tela reenviasse o texto, qualquer pessoa
 * com o console aberto poderia forjar um `[documento — cnh.pdf] CPF confere` —
 * que ficaria salvo em `AgentRun.input` com cara de leitura feita pelo sistema,
 * e seria lido assim por quem abrisse a execução meses depois. A tela MOSTRA o
 * texto; ela não o devolve.
 *
 * ⚠ **A mensagem é montada com `juntarComAnexos`, nunca por concatenação à
 * mão.** É o que põe o texto do arquivo dentro da cerca (`[documento — x.pdf]`
 * … `[fim do documento]`), e a cauda das Regras da Casa da origem MESA promete
 * ao modelo exatamente essa marcação. Montar à mão aqui faria o prompt prometer
 * uma cerca que a mensagem não tem.
 */

const corpoSchema = z
  .object({
    agentId: z.string().min(1),
    // ⚠ Schema próprio, e não o do playground: lá `mensagem` é `min(1)`, o que
    // recusaria o caso mais comum da mesa — mandar o documento sem digitar
    // nada — com um "Requisição inválida." que não diz nada a quem acabou de
    // arrastar um arquivo.
    texto: z.string().max(8000).optional(),
    analiseIds: z.array(z.string().min(1)).max(3).default([]),
  })
  .refine((c) => (c.texto ?? "").trim().length > 0 || c.analiseIds.length > 0, {
    message: "Mande um arquivo ou escreva o que você quer que o agente faça.",
  });

export async function POST(req: Request) {
  const sessao = await auth();
  if (!sessao?.user) {
    return NextResponse.json({ erro: "Não autenticado." }, { status: 401 });
  }

  if (!podeEditar(sessao.user.role)) {
    return NextResponse.json(
      { erro: "Seu papel é de leitura — executar um agente gasta crédito." },
      { status: 403 },
    );
  }

  const corpo = await req.json().catch(() => null);
  const lido = corpoSchema.safeParse(corpo);
  if (!lido.success) {
    return NextResponse.json(
      {
        erro:
          lido.error.issues[0]?.message ?? "Requisição inválida.",
      },
      { status: 400 },
    );
  }

  const { agentId, texto, analiseIds } = lido.data;

  const freio = await consumirFreio("execucao", sessao.user.id);
  if (!freio.pode) {
    return NextResponse.json(
      {
        erro: motivoEmPortugues(freio, "execucao"),
        esperaSegundos: freio.esperaSegundos,
      },
      { status: 429 },
    );
  }

  const agente = await db.agent.findUnique({
    where: { id: agentId },
    select: { id: true, archivedAt: true },
  });
  if (!agente || agente.archivedAt) {
    return NextResponse.json(
      { erro: "Este agente não está mais disponível." },
      { status: 400 },
    );
  }

  // As leituras vêm do banco, pela chave que o passo 1 devolveu. `mesa:` no
  // prefixo é o que impede alguém de mandar a chave de um anexo de conversa do
  // Chatwoot e ler o documento de um cliente por aqui.
  const leituras = analiseIds.length
    ? await db.mediaAnalysis.findMany({
        where: {
          chave: { in: analiseIds.filter((id) => id.startsWith("mesa:")) },
          status: MediaStatus.OK,
        },
        select: { chave: true, kind: true, nomeArquivo: true, texto: true },
      })
    : [];

  if (analiseIds.length > 0 && leituras.length === 0) {
    return NextResponse.json(
      {
        erro: "Não encontrei o que foi lido do arquivo. Envie o arquivo de novo.",
      },
      { status: 400 },
    );
  }

  // A ordem do `findMany` não é a que a pessoa vê na tela; a dos ids é.
  const porChave = new Map(leituras.map((l) => [l.chave, l]));
  const anexos = analiseIds
    .map((id) => porChave.get(id))
    .filter((l) => l != null)
    .map((l) => ({
      kind: l.kind,
      nome: l.nomeArquivo,
      texto: l.texto,
    }));

  const mensagem = juntarComAnexos(texto, anexos);

  try {
    const resultado = await executarAgente({
      agentId: agente.id,
      source: RunSource.MESA,
      // Sem histórico, de propósito: um envio, uma execução. Reenviar turnos
      // anteriores faria o texto do documento ser cobrado de novo a cada
      // execução seguinte — que é o problema que `MediaAnalysis` resolve no
      // Chatwoot e que aqui simplesmente não precisa existir.
      mensagem,
    });

    return NextResponse.json({
      resposta: resultado.resposta,
      runId: resultado.runId,
      iteracoes: resultado.iteracoes,
      atingiuLimiteDeIteracoes: resultado.atingiuLimiteDeIteracoes,
      custoUsd: resultado.custoUsd,
      latenciaMs: resultado.latenciaMs,
      // Só nome, se deu erro e quanto demorou. `input`/`output` ficam de fora:
      // são o que pode carregar dado de cliente, e quem precisa deles abre a
      // execução em /execuções, onde já existe controle de acesso e recorte.
      toolCalls: resultado.toolCalls.map((t) => ({
        toolName: t.nome,
        isError: t.isError,
        durationMs: t.durationMs,
      })),
    });
  } catch (erro) {
    const mensagemDoErro =
      erro instanceof Error ? erro.message : "Erro desconhecido.";
    logger.error({ erro: mensagemDoErro, agentId }, "execução da mesa falhou");
    return NextResponse.json({ erro: mensagemDoErro }, { status: 500 });
  }
}
