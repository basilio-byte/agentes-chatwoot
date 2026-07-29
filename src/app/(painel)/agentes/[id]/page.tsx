import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { ArrowLeft } from "lucide-react";
import { UserRole } from "@/generated/prisma/enums";
import { resumoDoBot } from "@/server/actions/chatwoot";
import { listarIntegracoes } from "@/server/integrations/registry";
import { ChatwootBotCard } from "@/components/chatwoot-bot";
import { IntegracoesDoAgente } from "@/components/integracoes-do-agente";
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
      versions: {
        orderBy: { version: "desc" },
        take: 5,
        include: { createdBy: { select: { name: true } } },
      },
      integrations: { include: { integration: true } },
      owner: { select: { name: true } },
      updatedBy: { select: { name: true } },
    },
  });
  if (!agente) notFound();

  const modelos = await listarModelos();

  // A URL do webhook é montada a partir do host da requisição — funciona em
  // local e no Easypanel sem precisar de variável de ambiente.
  const cabecalhos = await headers();
  const protocolo = cabecalhos.get("x-forwarded-proto") ?? "https";
  const host = cabecalhos.get("host") ?? "localhost:3000";
  const urlWebhook = `${protocolo}://${host}/api/webhooks/chatwoot/${agente.id}`;
  const resumoBot = await resumoDoBot(agente.id);

  // Todas as integrações que existem no registry, com o estado dos dois níveis
  // do toggle e a allowlist de tools deste agente.
  const configuradas = await db.integration.findMany();
  const integracoesDisponiveis = listarIntegracoes().map((definicao) => {
    const registro = configuradas.find(
      (i) => i.provider === definicao.provider,
    );
    const vinculo = agente.integrations.find(
      (v) => v.integration.provider === definicao.provider,
    );

    return {
      provider: definicao.provider,
      label: definicao.label,
      descricao: definicao.descricao,
      ligadaGlobalmente: registro?.enabled ?? false,
      configurada: Boolean(registro),
      ligadaNoAgente: vinculo?.enabled ?? false,
      permitidas: vinculo?.allowedTools ?? [],
      tools: definicao.tools.map((t) => ({
        name: t.name,
        description: t.description,
        escreve: Boolean(t.requiresConfirmation),
      })),
    };
  });

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

        <p className="text-xs text-muted">
          Dono: <strong className="font-medium">{agente.owner?.name ?? "—"}</strong>
          {" · "}
          última alteração por{" "}
          <strong className="font-medium">{agente.updatedBy?.name ?? "—"}</strong>{" "}
          em {formatarData(agente.updatedAt)}
        </p>
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

          <ChatwootBotCard
            agentId={agente.id}
            agentName={agente.name}
            resumo={resumoBot}
            urlWebhook={urlWebhook}
            podeEditarCredencial={sessao.user.role === UserRole.OWNER}
          />

          <IntegracoesDoAgente
            agentId={agente.id}
            editavel={editavel}
            integracoes={integracoesDisponiveis}
          />

          <Card className="space-y-3">
            <h2 className="text-sm font-semibold">Histórico de versões</h2>
            <ul className="space-y-2 text-sm">
              {agente.versions.map((versao) => (
                <li key={versao.id} className="flex items-baseline gap-2">
                  <Badge>v{versao.version}</Badge>
                  <span className="text-muted">
                    {versao.model} · effort {versao.effort} ·{" "}
                    {versao.createdBy?.name ?? "—"} ·{" "}
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
