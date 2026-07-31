import Link from "next/link";
import { Archive, Bot, Plus } from "lucide-react";
import { db } from "@/lib/db";
import { exigirSessao, podeEditar } from "@/server/auth-guard";
import { alternarAtivo } from "@/server/actions/agents";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Meta,
  PageHeader,
  Ponto,
} from "@/components/ui";
import { Abas } from "@/components/abas";
import { AcoesDoAgente } from "@/components/acoes-do-agente";
import { SeletorDeEntrada } from "@/components/seletor-de-entrada";
import { formatarData } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AgentesPage({
  searchParams,
}: {
  searchParams: Promise<{ aba?: string }>;
}) {
  const { aba } = await searchParams;
  const sessao = await exigirSessao();
  const editavel = podeEditar(sessao.user.role);

  const agentes = await db.agent.findMany({
    // Entrada primeiro: é o agente que define o comportamento do painel inteiro.
    orderBy: [{ isEntry: "desc" }, { active: "desc" }, { name: "asc" }],
    include: {
      owner: { select: { name: true } },
      updatedBy: { select: { name: true } },
      chatwootBot: { select: { botName: true } },
      _count: { select: { runs: true } },
    },
  });

  // Conversas ATENDIDAS, não conversas que o agente possui agora. Resolver
  // libera o dono (`Conversation.agentId` vira nulo), então contar por posse
  // faria o número sumir justamente quando o atendimento terminou bem.
  const atendidas = await db.$queryRaw<{ agentId: string; total: number }[]>`
    SELECT "agentId", COUNT(DISTINCT "conversationId")::int AS total
    FROM "AgentRun"
    WHERE "conversationId" IS NOT NULL
    GROUP BY "agentId"
  `;
  const conversasPorAgente = new Map(atendidas.map((a) => [a.agentId, a.total]));

  const ativos = agentes.filter((a) => !a.archivedAt);
  const arquivados = agentes.filter((a) => a.archivedAt);

  function cartao(agente: (typeof agentes)[number]) {
    const arquivado = Boolean(agente.archivedAt);

    return (
      <Card
        key={agente.id}
        className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4"
      >
        <Ponto ligado={agente.active} />

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/agentes/${agente.id}`}
              className="text-sm font-medium hover:text-accent hover:underline"
            >
              {agente.name}
            </Link>
            {arquivado ? <Badge>arquivado</Badge> : null}
            {agente.isEntry ? <Badge tone="accent">entrada</Badge> : null}
            {agente.chatwootBot ? (
              <Badge tone="accent">{agente.chatwootBot.botName}</Badge>
            ) : (
              <Badge>sem bot</Badge>
            )}
            {agente.inboxMode === "specific" && agente.inboxIds.length > 0 ? (
              <Badge title="Caixas de entrada em que atua">
                caixa{agente.inboxIds.length > 1 ? "s" : ""}{" "}
                {agente.inboxIds.join(", ")}
              </Badge>
            ) : null}
          </div>

          <p className="truncate text-[13px] text-muted">
            {agente.description || "Sem descrição"}
          </p>

          <Meta className="block truncate font-mono">{agente.model}</Meta>
        </div>

        <div className="space-y-1 text-right">
          <Meta className="block">
            {conversasPorAgente.get(agente.id) ?? 0} conversa(s) ·{" "}
            {agente._count.runs} execução(ões)
          </Meta>
          <Meta className="block">dono: {agente.owner?.name ?? "—"}</Meta>
          <Meta className="block">
            {arquivado && agente.archivedAt
              ? `arquivado em ${formatarData(agente.archivedAt)}`
              : `alterado por ${agente.updatedBy?.name ?? "—"} em ${formatarData(agente.updatedAt)}`}
          </Meta>
        </div>

        <div className="flex flex-wrap items-start justify-end gap-2">
          {/* Arquivado não mostra entrada nem liga/desliga: a única saída é
              restaurar, e aí ligar volta a ser uma decisão consciente. */}
          {!arquivado && (editavel || agente.isEntry) ? (
            <SeletorDeEntrada agenteId={agente.id} ehEntrada={agente.isEntry} />
          ) : null}

          {!arquivado && editavel ? (
            <form action={alternarAtivo.bind(null, agente.id)}>
              <Button variant="secondary" size="sm">
                {agente.active ? "Desligar" : "Ligar"}
              </Button>
            </form>
          ) : null}

          {editavel ? (
            <AcoesDoAgente
              agenteId={agente.id}
              nome={agente.name}
              arquivado={arquivado}
            />
          ) : null}
        </div>
      </Card>
    );
  }

  const criar = editavel ? (
    <Link
      href="/agentes/novo"
      className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-white shadow-sm transition hover:brightness-110"
    >
      <Plus size={16} aria-hidden />
      Novo agente
    </Link>
  ) : null;

  return (
    <>
      <PageHeader
        titulo="Agentes"
        descricao="Cada agente tem o próprio prompt, modelo e integrações. Um agente desligado não responde no Chatwoot, mas continua disponível no playground."
        acoes={criar}
        semBorda
      />

      <Abas
        inicial={aba}
        itens={[
          {
            id: "ativos",
            rotulo: "Agentes ativos",
            icone: <Bot size={15} aria-hidden />,
            contador: ativos.length,
            conteudo:
              ativos.length === 0 ? (
                <EmptyState
                  icone={<Bot size={18} aria-hidden />}
                  titulo="Nenhum agente ainda"
                  descricao="Crie o primeiro e ajuste o prompt no playground antes de ligá-lo no Chatwoot."
                  acao={criar}
                />
              ) : (
                <div className="space-y-2">{ativos.map(cartao)}</div>
              ),
          },
          {
            id: "arquivados",
            rotulo: "Arquivados",
            icone: <Archive size={15} aria-hidden />,
            contador: arquivados.length,
            conteudo:
              arquivados.length === 0 ? (
                <EmptyState
                  icone={<Archive size={18} aria-hidden />}
                  titulo="Nada arquivado"
                  descricao="Arquivar tira o agente de circulação e o desliga, mas mantém prompt, integrações e histórico. Dá para restaurar quando quiser."
                />
              ) : (
                <div className="space-y-2">{arquivados.map(cartao)}</div>
              ),
          },
        ]}
      />
    </>
  );
}
