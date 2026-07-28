import Link from "next/link";
import { Plus } from "lucide-react";
import { db } from "@/lib/db";
import { exigirSessao, podeEditar } from "@/server/auth-guard";
import { alternarAtivo } from "@/server/actions/agents";
import { Badge, Button, Card } from "@/components/ui";
import { formatarData } from "@/lib/utils";

export default async function AgentesPage() {
  const sessao = await exigirSessao();
  const editavel = podeEditar(sessao.user.role);

  const agentes = await db.agent.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: {
      _count: { select: { inboxes: true, runs: true } },
    },
  });

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Agentes</h1>
          <p className="text-sm text-muted">
            Cada agente tem seu próprio prompt e suas próprias integrações.
          </p>
        </div>

        {editavel ? (
          <Link
            href="/agentes/novo"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white hover:opacity-90"
          >
            <Plus size={16} aria-hidden />
            Novo agente
          </Link>
        ) : null}
      </header>

      {agentes.length === 0 ? (
        <Card className="text-center">
          <p className="text-sm text-muted">
            Nenhum agente ainda. Crie o primeiro e teste no playground antes de
            ligar no Chatwoot.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {agentes.map((agente) => (
            <Card key={agente.id} className="flex items-center gap-4">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/agentes/${agente.id}`}
                    className="font-medium hover:underline"
                  >
                    {agente.name}
                  </Link>
                  <Badge tone={agente.active ? "success" : "neutral"}>
                    {agente.active ? "ativo" : "desligado"}
                  </Badge>
                </div>

                <p className="truncate text-sm text-muted">
                  {agente.description || "Sem descrição"}
                </p>

                <p className="text-xs text-muted">
                  <span className="font-mono">{agente.model}</span> · effort{" "}
                  {agente.effort} · {agente._count.inboxes} inbox(es) ·{" "}
                  {agente._count.runs} execuções · atualizado em{" "}
                  {formatarData(agente.updatedAt)}
                </p>
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
    </div>
  );
}
