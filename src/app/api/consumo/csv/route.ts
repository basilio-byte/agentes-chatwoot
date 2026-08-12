import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { FUSO_SEAHUB } from "@/lib/tempo";
import {
  montarWhere,
  normalizarFonte,
  TETO_DE_LINHAS,
} from "@/server/consumo/consulta";
import { intervaloDoPeriodo, normalizarPeriodo } from "@/server/consumo/periodo";
import { nomeDoArquivo, paraCsv } from "@/server/consumo/csv";

export const dynamic = "force-dynamic";

/**
 * Exportação da apuração em CSV, uma linha por execução.
 *
 * Checa a própria sessão: o `proxy.ts` não cobre `/api/*` de propósito — um
 * redirect devolveria HTML onde o cliente espera um arquivo.
 */
export async function GET(req: NextRequest) {
  const sessao = await auth();
  if (!sessao?.user) {
    return NextResponse.json({ erro: "Não autenticado." }, { status: 401 });
  }

  const p = req.nextUrl.searchParams;
  const intervalo = intervaloDoPeriodo(normalizarPeriodo(p.get("periodo")), {
    de: p.get("de"),
    ate: p.get("ate"),
  });

  const where = montarWhere({
    intervalo,
    agentId: p.get("agente"),
    model: p.get("modelo"),
    source: normalizarFonte(p.get("fonte")),
  });

  const linhas = await db.agentRun.findMany({
    where,
    orderBy: { createdAt: "asc" },
    // O mesmo teto da tela. Aqui ele é generoso de propósito — a planilha
    // aguenta mais do que o gráfico —, mas continua existindo para uma
    // exportação sem filtro não tentar carregar o banco inteiro na memória.
    take: TETO_DE_LINHAS,
    select: {
      createdAt: true,
      model: true,
      source: true,
      status: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      costUsd: true,
      latencyMs: true,
      iterations: true,
      error: true,
      agent: { select: { name: true } },
      conversation: { select: { chatwootConversationId: true } },
    },
  });

  const csv = paraCsv(
    linhas.map((l) => ({
      createdAt: l.createdAt,
      agente: l.agent.name,
      model: l.model,
      source: l.source,
      status: l.status,
      chatwootConversationId: l.conversation?.chatwootConversationId ?? null,
      inputTokens: l.inputTokens,
      outputTokens: l.outputTokens,
      cacheReadTokens: l.cacheReadTokens,
      costUsd: Number(l.costUsd ?? 0),
      latencyMs: l.latencyMs,
      iterations: l.iterations,
      erro: l.error,
    })),
    FUSO_SEAHUB,
  );

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nomeDoArquivo(
        intervalo.primeiroDia,
        intervalo.ultimoDia,
      )}"`,
      // Apuração é dado vivo: nada de cache intermediário guardando o mês
      // fechado de ontem.
      "Cache-Control": "no-store",
    },
  });
}
