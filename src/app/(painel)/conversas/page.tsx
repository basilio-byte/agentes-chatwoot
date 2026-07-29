import Link from "next/link";
import { MessagesSquare } from "lucide-react";
import { db } from "@/lib/db";
import { exigirSessao } from "@/server/auth-guard";
import { chatwootConfigSchema } from "@/server/integrations/chatwoot/config";
import {
  ConversationStatus,
  IntegrationProvider,
  RunStatus,
} from "@/generated/prisma/enums";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatarData, formatarUsd } from "@/lib/utils";

export const dynamic = "force-dynamic";

const ROTULO: Record<ConversationStatus, { texto: string; tom: "success" | "accent" | "neutral" }> = {
  [ConversationStatus.BOT]: { texto: "com o bot", tom: "success" },
  [ConversationStatus.HUMAN]: { texto: "com humano", tom: "accent" },
  [ConversationStatus.CLOSED]: { texto: "encerrada", tom: "neutral" },
};

export default async function ConversasPage() {
  await exigirSessao();

  const [conversas, integracao] = await Promise.all([
    db.conversation.findMany({
      orderBy: { lastMessageAt: "desc" },
      take: 50,
      include: {
        agent: { select: { id: true, name: true } },
        runs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            output: true,
            costUsd: true,
            latencyMs: true,
            createdAt: true,
          },
        },
        _count: { select: { runs: true } },
      },
    }),
    db.integration.findUnique({
      where: { provider: IntegrationProvider.CHATWOOT },
    }),
  ]);

  const config = chatwootConfigSchema.safeParse(integracao?.config ?? {});
  const linkChatwoot = (id: number) =>
    config.success
      ? `${config.data.baseUrl}/app/accounts/${config.data.accountId}/conversations/${id}`
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        titulo="Conversas"
        descricao="Atendimentos vindos do Chatwoot, com o custo e a latência de cada resposta. Últimos 50."
      />

      {conversas.length === 0 ? (
        <EmptyState
          icone={<MessagesSquare size={18} aria-hidden />}
          titulo="Nenhuma conversa ainda"
          descricao="Configure o bot de um agente, vincule a uma inbox e mande uma mensagem por lá. Lembre de ligar o worker, senão as mensagens ficam na fila."
        />
      ) : (
        <div className="space-y-2">
          {conversas.map((conversa) => {
            const ultima = conversa.runs[0];
            const rotulo = ROTULO[conversa.status];
            const url = linkChatwoot(conversa.chatwootConversationId);

            return (
              <Card key={conversa.id} className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone={rotulo.tom}>{rotulo.texto}</Badge>

                  <span className="text-sm font-medium">
                    {conversa.contactName ?? "Contato sem nome"}
                  </span>

                  {conversa.contactIdentifier ? (
                    <span className="text-muted">
                      {conversa.contactIdentifier}
                    </span>
                  ) : null}

                  {conversa.agent ? (
                    <Link
                      href={`/agentes/${conversa.agent.id}`}
                      className="text-muted hover:underline"
                    >
                      agente: {conversa.agent.name}
                    </Link>
                  ) : null}

                  <span className="text-muted">
                    {conversa._count.runs} resposta(s)
                    {conversa.lastMessageAt
                      ? ` · ${formatarData(conversa.lastMessageAt)}`
                      : ""}
                  </span>

                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto underline"
                    >
                      abrir no Chatwoot
                    </a>
                  ) : null}
                </div>

                {conversa.handoffReason ? (
                  <p className="text-sm text-accent">
                    Transferida: {conversa.handoffReason}
                  </p>
                ) : null}

                {ultima ? (
                  <div className="space-y-1">
                    <p className="line-clamp-2 text-sm text-muted">
                      {ultima.status === RunStatus.ERROR
                        ? "A última execução falhou — veja em Execuções."
                        : ultima.output}
                    </p>
                    <p className="text-xs text-muted">
                      última resposta em {formatarData(ultima.createdAt)} ·{" "}
                      {ultima.latencyMs ?? "—"} ms ·{" "}
                      {formatarUsd(Number(ultima.costUsd ?? 0))}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-muted">Ainda sem resposta.</p>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
