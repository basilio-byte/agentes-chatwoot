import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { podeEditar } from "@/server/auth-guard";
import { executarAgente } from "@/server/agents/runner";
import { RunSource } from "@/generated/prisma/enums";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const corpoSchema = z.object({
  agentId: z.string().min(1),
  mensagem: z.string().min(1).max(8000),
  historico: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .max(50)
    .default([]),
});

export async function POST(req: Request) {
  const sessao = await auth();
  if (!sessao?.user) {
    return NextResponse.json({ erro: "Não autenticado." }, { status: 401 });
  }

  // Playground roda o modelo de verdade e a OpenRouter cobra por isso. Só a
  // sessão não basta: sem esta checagem, "Leitura" gastava crédito — e a tela
  // de Usuários prometia justamente o contrário. A UI já esconde o playground
  // de quem não edita; aqui é onde a promessa é garantida.
  if (!podeEditar(sessao.user.role)) {
    return NextResponse.json(
      { erro: "Seu papel é de leitura — testar um agente gasta crédito." },
      { status: 403 },
    );
  }

  const parsed = corpoSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ erro: "Requisição inválida." }, { status: 400 });
  }

  try {
    const resultado = await executarAgente({
      agentId: parsed.data.agentId,
      source: RunSource.PLAYGROUND,
      historico: parsed.data.historico,
      mensagem: parsed.data.mensagem,
    });

    return NextResponse.json({
      resposta: resultado.resposta,
      runId: resultado.runId,
      iteracoes: resultado.iteracoes,
      atingiuLimiteDeIteracoes: resultado.atingiuLimiteDeIteracoes,
      toolCalls: resultado.toolCalls,
      uso: resultado.uso,
      custoUsd: resultado.custoUsd,
      latenciaMs: resultado.latenciaMs,
    });
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : "Erro desconhecido.";
    logger.error({ erro: mensagem }, "playground falhou");
    return NextResponse.json({ erro: mensagem }, { status: 500 });
  }
}
