import Link from "next/link";
import { Bot, CheckCheck, MessagesSquare, UserRound } from "lucide-react";
import { Abas } from "@/components/abas";
import { EstadoDoWorker } from "@/components/estado-do-worker";
import { estadoDoWorker } from "@/server/queue/batimento";
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

const ROTULO: Record<
  ConversationStatus,
  { texto: string; tom: "success" | "accent" | "neutral" }
> = {
  [ConversationStatus.BOT]: { texto: "com o bot", tom: "success" },
  [ConversationStatus.HUMAN]: { texto: "com humano", tom: "accent" },
  [ConversationStatus.CLOSED]: { texto: "encerrada", tom: "neutral" },
};

export default async function ConversasPage({
  searchParams,
}: {
  searchParams: Promise<{ aba?: string }>;
}) {
  const { aba } = await searchParams;
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
        handoffs: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            motivo: true,
            createdAt: true,
            fromAgent: { select: { name: true } },
            toAgent: { select: { name: true } },
          },
        },
        _count: { select: { runs: true } },
      },
    }),
    db.integration.findUnique({
      where: { provider: IntegrationProvider.CHATWOOT },
    }),
  ]);

  const worker = await estadoDoWorker();
  const config = chatwootConfigSchema.safeParse(integracao?.config ?? {});
  const linkChatwoot = (id: number) =>
    config.success
      ? `${config.data.baseUrl}/app/accounts/${config.data.accountId}/conversations/${id}`
      : null;

  /** Um card de conversa. Extraído para as abas reaproveitarem sem duplicar. */
  function cartao(conversa: (typeof conversas)[number]) {
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
            <span className="text-muted">{conversa.contactIdentifier}</span>
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

        {conversa.ultimaFalha ? (
          <p className="rounded-lg border border-danger/25 bg-danger/[0.06] px-3 py-2 text-[13px] text-danger">
            Última tentativa falhou: {conversa.ultimaFalha}
          </p>
        ) : null}

        {conversa.handoffReason ? (
          <p className="text-sm text-accent">
            Transferida: {conversa.handoffReason}
          </p>
        ) : null}

        {conversa.handoffs.length > 0 ? (
          <div className="space-y-1 rounded-lg border border-line px-3 py-2">
            <p className="text-xs font-medium text-muted">
              Passagens entre agentes
            </p>
            <ol className="space-y-1">
              {conversa.handoffs.map((passagem) => (
                <li key={passagem.id} className="text-xs text-muted">
                  <span className="font-medium">
                    {passagem.fromAgent?.name ?? "—"} → {passagem.toAgent.name}
                  </span>
                  {passagem.motivo ? ` · ${passagem.motivo}` : ""}
                  {" · "}
                  {formatarData(passagem.createdAt)}
                </li>
              ))}
            </ol>
          </div>
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
  }

  const lista = (filtradas: typeof conversas, vazioTexto: string) =>
    filtradas.length === 0 ? (
      <EmptyState
        icone={<MessagesSquare size={18} aria-hidden />}
        titulo={vazioTexto}
        descricao="Configure o bot de um agente, vincule a uma inbox e mande uma mensagem por lá. Lembre de ligar o worker, senão as mensagens ficam na fila."
      />
    ) : (
      <div className="space-y-2">{filtradas.map(cartao)}</div>
    );

  const porStatus = (status: ConversationStatus) =>
    conversas.filter((c) => c.status === status);

  const comBot = porStatus(ConversationStatus.BOT);
  const comHumano = porStatus(ConversationStatus.HUMAN);
  const encerradas = porStatus(ConversationStatus.CLOSED);

  return (
    <div className="space-y-6">
      <PageHeader
        titulo="Conversas"
        descricao="Atendimentos vindos do Chatwoot, com o custo e a latência de cada resposta. Últimos 50."
        semBorda
      />

      <EstadoDoWorker estado={worker} />

      <Abas
        inicial={aba}
        itens={[
          {
            id: "todas",
            rotulo: "Todas",
            contador: conversas.length,
            conteudo: lista(conversas, "Nenhuma conversa ainda"),
          },
          {
            id: "bot",
            rotulo: "Com o agente",
            icone: <Bot size={14} aria-hidden />,
            contador: comBot.length,
            conteudo: lista(comBot, "Nenhuma conversa com o agente agora"),
          },
          {
            id: "humano",
            rotulo: "Com humano",
            icone: <UserRound size={14} aria-hidden />,
            contador: comHumano.length,
            conteudo: lista(comHumano, "Nenhuma conversa assumida por humano"),
          },
          {
            id: "encerradas",
            rotulo: "Encerradas",
            icone: <CheckCheck size={14} aria-hidden />,
            contador: encerradas.length,
            conteudo: lista(
              encerradas,
              "Nenhuma conversa encerrada nos últimos 50",
            ),
          },
        ]}
      />
    </div>
  );
}
