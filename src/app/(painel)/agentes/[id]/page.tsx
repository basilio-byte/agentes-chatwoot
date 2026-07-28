import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { db } from "@/lib/db";
import { exigirSessao, podeEditar } from "@/server/auth-guard";
import {
  alternarAtivo,
  atualizarAgente,
  excluirAgente,
} from "@/server/actions/agents";
import { AgenteForm } from "@/components/agente-form";
import { Playground } from "@/components/playground";
import { Aviso, Badge, Button, Card } from "@/components/ui";
import { formatarData } from "@/lib/utils";
import { openrouterConfigurada } from "@/server/agents/openrouter";
import { listarModelos } from "@/server/agents/catalogo";

export default async function AgentePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sessao = await exigirSessao();
  const editavel = podeEditar(sessao.user.role);

  const agente = await db.agent.findUnique({
    where: { id },
    include: {
      versions: { orderBy: { version: "desc" }, take: 5 },
      integrations: { include: { integration: true } },
    },
  });
  if (!agente) notFound();

  const modelos = await listarModelos();
  const integracoesAtivas = agente.integrations.filter(
    (v) => v.enabled && v.integration.enabled,
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href="/agentes"
          className="inline-flex items-center gap-1 text-sm text-muted hover:underline"
        >
          <ArrowLeft size={14} aria-hidden />
          Agentes
        </Link>

        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">{agente.name}</h1>
          <Badge tone={agente.active ? "success" : "neutral"}>
            {agente.active ? "ativo" : "desligado"}
          </Badge>

          {editavel ? (
            <form action={alternarAtivo.bind(null, agente.id)}>
              <Button variant="secondary" size="sm">
                {agente.active ? "Desligar" : "Ligar"}
              </Button>
            </form>
          ) : null}
        </div>
      </div>

      {!openrouterConfigurada() ? (
        <Aviso tone="danger">
          OPENROUTER_API_KEY não está configurada — o playground vai falhar.
          Pegue a chave em openrouter.ai/keys e defina no .env (local) ou no
          Easypanel.
        </Aviso>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_480px]">
        <div className="space-y-6">
          <AgenteForm
            acao={atualizarAgente.bind(null, agente.id)}
            modelos={modelos}
            rotuloEnvio="Salvar alterações"
            somenteLeitura={!editavel}
            valores={{
              name: agente.name,
              description: agente.description ?? "",
              systemPrompt: agente.systemPrompt,
              model: agente.model,
              effort: agente.effort,
              maxTokens: agente.maxTokens,
              maxToolIterations: agente.maxToolIterations,
            }}
          />

          <Card className="space-y-3">
            <h2 className="text-sm font-semibold">Integrações deste agente</h2>
            {integracoesAtivas.length === 0 ? (
              <p className="text-sm text-muted">
                Nenhuma integração ligada. O agente responde só com o que está no
                prompt.{" "}
                <Link href="/integracoes" className="underline">
                  Ver integrações
                </Link>
              </p>
            ) : (
              <ul className="space-y-1 text-sm">
                {integracoesAtivas.map((vinculo) => (
                  <li key={vinculo.id} className="flex items-center gap-2">
                    <Badge tone="accent">{vinculo.integration.provider}</Badge>
                    <span className="text-muted">
                      {vinculo.allowedTools.length === 0
                        ? "todas as tools"
                        : `${vinculo.allowedTools.length} tool(s)`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="space-y-3">
            <h2 className="text-sm font-semibold">Histórico de versões</h2>
            <ul className="space-y-2 text-sm">
              {agente.versions.map((versao) => (
                <li key={versao.id} className="flex items-baseline gap-2">
                  <Badge>v{versao.version}</Badge>
                  <span className="text-muted">
                    {versao.model} · effort {versao.effort} ·{" "}
                    {formatarData(versao.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          {editavel ? (
            <Card className="space-y-3 border-danger/30">
              <h2 className="text-sm font-semibold text-danger">
                Excluir agente
              </h2>
              <p className="text-sm text-muted">
                Remove o agente e todo o histórico de execuções. Não tem volta.
              </p>
              <form action={excluirAgente.bind(null, agente.id)}>
                <Button variant="danger" size="sm">
                  Excluir definitivamente
                </Button>
              </form>
            </Card>
          ) : null}
        </div>

        <div className="xl:sticky xl:top-8 xl:self-start">
          <Playground agentId={agente.id} agenteAtivo={agente.active} />
        </div>
      </div>
    </div>
  );
}
