import Link from "next/link";
import { ScrollText } from "lucide-react";
import { db } from "@/lib/db";
import { exigirSessao } from "@/server/auth-guard";
import { RunStatus } from "@/generated/prisma/enums";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatarData, formatarUsd } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Trace de execuções. É esta tela que responde "por que o bot respondeu isso?".
 */
export default async function ExecucoesPage() {
  await exigirSessao();

  const execucoes = await db.agentRun.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      agent: { select: { id: true, name: true } },
      toolCalls: { select: { toolName: true, isError: true } },
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        titulo="Execuções"
        descricao="Cada resposta gerada, com tokens, custo e tools chamadas. É esta tela que responde por que o bot respondeu daquele jeito. Últimas 50."
      />

      {execucoes.length === 0 ? (
        <EmptyState
          icone={<ScrollText size={18} aria-hidden />}
          titulo="Nenhuma execução ainda"
          descricao="Use o playground de um agente para gerar a primeira."
        />
      ) : (
        <div className="space-y-2">
          {execucoes.map((execucao) => (
            <Card key={execucao.id} className="space-y-2 p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge
                  tone={
                    execucao.status === RunStatus.ERROR ? "danger" : "success"
                  }
                >
                  {execucao.status}
                </Badge>
                <Badge>{execucao.source}</Badge>
                <Link
                  href={`/agentes/${execucao.agent.id}`}
                  className="font-medium hover:underline"
                >
                  {execucao.agent.name}
                </Link>
                <span className="text-muted">
                  {formatarData(execucao.createdAt)} · {execucao.latencyMs ?? "—"}{" "}
                  ms · {formatarUsd(Number(execucao.costUsd ?? 0))} ·{" "}
                  {execucao.inputTokens + execucao.outputTokens} tokens
                </span>
              </div>

              <p className="line-clamp-2 text-sm">
                <span className="text-muted">Entrada: </span>
                {execucao.input}
              </p>

              {execucao.error ? (
                <p className="text-sm text-danger">{execucao.error}</p>
              ) : (
                <p className="line-clamp-2 text-sm text-muted">
                  {execucao.output}
                </p>
              )}

              {execucao.toolCalls.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {execucao.toolCalls.map((tool, i) => (
                    <Badge key={i} tone={tool.isError ? "danger" : "accent"}>
                      {tool.toolName}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
