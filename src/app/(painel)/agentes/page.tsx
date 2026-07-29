import Link from "next/link";
import { Bot, Plus } from "lucide-react";
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
import { formatarData } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AgentesPage() {
  const sessao = await exigirSessao();
  const editavel = podeEditar(sessao.user.role);

  const agentes = await db.agent.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: {
      owner: { select: { name: true } },
      updatedBy: { select: { name: true } },
      chatwootBot: { select: { botName: true } },
      _count: { select: { runs: true, conversations: true } },
    },
  });

  return (
    <>
      <PageHeader
        titulo="Agentes"
        descricao="Cada agente tem o próprio prompt, modelo e integrações. Um agente desligado não responde no Chatwoot, mas continua disponível no playground."
        acoes={
          editavel ? (
            <Link
              href="/agentes/novo"
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-white shadow-sm transition hover:brightness-110"
            >
              <Plus size={16} aria-hidden />
              Novo agente
            </Link>
          ) : null
        }
      />

      {agentes.length === 0 ? (
        <EmptyState
          icone={<Bot size={18} aria-hidden />}
          titulo="Nenhum agente ainda"
          descricao="Crie o primeiro e ajuste o prompt no playground antes de ligá-lo no Chatwoot."
          acao={
            editavel ? (
              <Link
                href="/agentes/novo"
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-white"
              >
                <Plus size={16} aria-hidden />
                Criar agente
              </Link>
            ) : null
          }
        />
      ) : (
        <div className="space-y-2">
          {agentes.map((agente) => (
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
                  {agente.chatwootBot ? (
                    <Badge tone="accent">{agente.chatwootBot.botName}</Badge>
                  ) : (
                    <Badge>sem bot</Badge>
                  )}
                </div>

                <p className="truncate text-[13px] text-muted">
                  {agente.description || "Sem descrição"}
                </p>

                <Meta className="block truncate font-mono">{agente.model}</Meta>
              </div>

              <div className="space-y-1 text-right">
                <Meta className="block">
                  {agente._count.conversations} conversa(s) ·{" "}
                  {agente._count.runs} execução(ões)
                </Meta>
                <Meta className="block">
                  dono: {agente.owner?.name ?? "—"}
                </Meta>
                <Meta className="block">
                  alterado por {agente.updatedBy?.name ?? "—"} em{" "}
                  {formatarData(agente.updatedAt)}
                </Meta>
              </div>

              {editavel ? (
                <form action={alternarAtivo.bind(null, agente.id)}>
                  <Button variant="secondary" size="sm">
                    {agente.active ? "Desligar" : "Ligar"}
                  </Button>
                </form>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
