import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import {
  ArrowLeft,
  Bot,
  FlaskConical,
  History,
  MessagesSquare,
  Plug,
  Users,
} from "lucide-react";
import { Abas } from "@/components/abas";
import { UserRole } from "@/generated/prisma/enums";
import { resumoDoBot } from "@/server/actions/chatwoot";
import { obterConfigChatwoot } from "@/server/integrations/chatwoot/credenciais";
import { listarIntegracoes } from "@/server/integrations/registry";
import { tokensAproximadosDaTool } from "@/server/integrations/resolve";
import { ChatwootBotCard } from "@/components/chatwoot-bot";
import { IntegracoesDoAgente } from "@/components/integracoes-do-agente";
import { EquipeDoAgente } from "@/components/equipe-do-agente";
import { EscopoDoAgente } from "@/components/escopo-do-agente";
import { EntregasDoWebhook } from "@/components/entregas-do-webhook";
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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ aba?: string }>;
}) {
  const { id } = await params;
  const { aba } = await searchParams;
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
      chatwootBot: { select: { accountId: true } },
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
  const entregas = await db.webhookEvent.findMany({
    where: { agentId: agente.id },
    // Cinquenta na lista rolável; a poda no worker cuida do resto.
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, eventType: true, resultado: true, detalhe: true, createdAt: true },
  });

  const { config: configChatwoot } = await obterConfigChatwoot();
  const contaPadrao = configChatwoot?.accountId ?? null;

  const colegas = await db.agent.findMany({
    where: { id: { not: agente.id } },
    select: {
      id: true,
      key: true,
      name: true,
      routingDescription: true,
      active: true,
      isEntry: true,
    },
    orderBy: [{ isEntry: "desc" }, { name: "asc" }],
  });

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
        categoria: t.categoria ?? "Geral",
        tokens: tokensAproximadosDaTool(t),
      })),
    };
  });

  // Contadores das abas: mostram o essencial sem obrigar a entrar em cada uma.
  const temRoteamento = (agente.routingDescription ?? "").trim().length > 0;
  const colegasAlcancaveis = colegas.filter(
    (c) => c.active && (c.routingDescription ?? "").trim().length > 0,
  ).length;
  const integracoesLigadas = integracoesDisponiveis.filter(
    (i) => i.ligadaNoAgente && i.ligadaGlobalmente,
  ).length;

  return (
    <div className="space-y-6">
      {/* Sem borda inferior: a tira de abas logo abaixo já traz a linha. */}
      <div className="space-y-3">
        <Link
          href="/agentes"
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
        >
          <ArrowLeft size={14} aria-hidden />
          Agentes
        </Link>

        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[22px] font-semibold tracking-tight">
            {agente.name}
          </h1>
          <Badge tone={agente.active ? "success" : "neutral"}>
            {agente.active ? "ativo" : "desligado"}
          </Badge>
          {agente.isEntry ? <Badge tone="accent">entrada</Badge> : null}
          <code className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-xs text-muted">
            {agente.key}
          </code>

          {editavel ? (
            <form
              action={alternarAtivo.bind(null, agente.id)}
              className="ml-auto"
            >
              <Button variant="secondary" size="sm">
                {agente.active ? "Desligar" : "Ligar"}
              </Button>
            </form>
          ) : null}
        </div>

        <p className="text-xs text-muted">
          {agente.description ? `${agente.description} · ` : ""}
          Dono:{" "}
          <strong className="font-medium">{agente.owner?.name ?? "—"}</strong>
          {" · "}
          última alteração por{" "}
          <strong className="font-medium">
            {agente.updatedBy?.name ?? "—"}
          </strong>{" "}
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

      <Abas
        inicial={aba}
        itens={[
          {
            id: "agente",
            rotulo: "Agente",
            icone: <Bot size={15} aria-hidden />,
            conteudo: (
              <div className="max-w-3xl">
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
                    routingDescription: agente.routingDescription ?? "",
                  }}
                />
              </div>
            ),
          },
          {
            id: "testar",
            rotulo: "Testar",
            icone: <FlaskConical size={15} aria-hidden />,
            // Painel de aba fica montado: a conversa sobrevive a ir em
            // Integrações ligar uma ferramenta e voltar para cá.
            conteudo: (
              <div className="max-w-3xl">
                <Playground agentId={agente.id} agenteAtivo={agente.active} />
              </div>
            ),
          },
          {
            id: "canal",
            rotulo: "Canal",
            icone: <MessagesSquare size={15} aria-hidden />,
            // Sem bot configurado o agente não atende ninguém — o ponto evita
            // ter de abrir a aba para descobrir isso.
            // Sem bot não é problema para quem atende por transferência. O que
            // é problema: ser a porta (tem bot) com a instância mal configurada.
            alerta: resumoBot.configurado && !resumoBot.instanciaOk,
            conteudo: (
              <div className="max-w-3xl space-y-6">
                <ChatwootBotCard
                  agentId={agente.id}
                  agentName={agente.name}
                  resumo={resumoBot}
                  urlWebhook={urlWebhook}
                  podeEditarCredencial={sessao.user.role === UserRole.OWNER}
                />

                <EntregasDoWebhook entregas={entregas} />

                <EscopoDoAgente
                  agentId={agente.id}
                  inboxMode={agente.inboxMode}
                  inboxIds={agente.inboxIds}
                  accountId={agente.chatwootBot?.accountId ?? null}
                  contaPadrao={contaPadrao}
                  temBot={Boolean(agente.chatwootBot)}
                  somenteLeitura={!editavel}
                />
              </div>
            ),
          },
          {
            id: "equipe",
            rotulo: "Equipe",
            icone: <Users size={15} aria-hidden />,
            contador: colegasAlcancaveis,
            conteudo: (
              <div className="max-w-3xl">
                <EquipeDoAgente
                  agenteId={agente.id}
                  agenteKey={agente.key}
                  ehEntrada={agente.isEntry}
                  temDescricaoDeRoteamento={temRoteamento}
                  colegas={colegas}
                  editavel={editavel}
                />
              </div>
            ),
          },
          {
            id: "integracoes",
            rotulo: "Integrações",
            icone: <Plug size={15} aria-hidden />,
            contador: integracoesLigadas,
            conteudo: (
              <div className="max-w-3xl">
                <IntegracoesDoAgente
                  agentId={agente.id}
                  editavel={editavel}
                  integracoes={integracoesDisponiveis}
                />
              </div>
            ),
          },
          {
            id: "historico",
            rotulo: "Histórico",
            icone: <History size={15} aria-hidden />,
            conteudo: (
              <div className="max-w-3xl space-y-6">
                <Card className="space-y-3">
                  <h2 className="text-sm font-semibold">
                    Histórico de versões
                  </h2>
                  <p className="text-xs text-muted">
                    Uma versão nova é criada quando muda o prompt, o modelo ou o
                    effort. Editar nome ou descrição não versiona.
                  </p>
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
                      Remove o agente e todo o histórico de execuções. Não tem
                      volta.
                    </p>
                    <form action={excluirAgente.bind(null, agente.id)}>
                      <Button variant="danger" size="sm">
                        Excluir definitivamente
                      </Button>
                    </form>
                  </Card>
                ) : null}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
