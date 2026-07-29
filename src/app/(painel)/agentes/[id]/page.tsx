import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import {
  ArrowLeft,
  Bot,
  History,
  MessagesSquare,
  Plug,
  Users,
} from "lucide-react";
import { Abas } from "@/components/abas";
import { UserRole } from "@/generated/prisma/enums";
import { resumoDoBot } from "@/server/actions/chatwoot";
import { listarIntegracoes } from "@/server/integrations/registry";
import { tokensAproximadosDaTool } from "@/server/integrations/resolve";
import { ChatwootBotCard } from "@/components/chatwoot-bot";
import { IntegracoesDoAgente } from "@/components/integracoes-do-agente";
import { EquipeDoAgente } from "@/components/equipe-do-agente";
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

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_480px]">
        <Abas
          inicial={aba}
          itens={[
            {
              id: "agente",
              rotulo: "Agente",
              icone: <Bot size={14} aria-hidden />,
              conteudo: (
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
              ),
            },
            {
              id: "canal",
              rotulo: "Canal",
              icone: <MessagesSquare size={14} aria-hidden />,
              // Sem bot configurado o agente não atende ninguém — a bolinha
              // evita ter de abrir a aba para descobrir isso.
              alerta: !resumoBot.configurado || !resumoBot.instanciaOk,
              conteudo: (
                <ChatwootBotCard
                  agentId={agente.id}
                  agentName={agente.name}
                  resumo={resumoBot}
                  urlWebhook={urlWebhook}
                  podeEditarCredencial={sessao.user.role === UserRole.OWNER}
                />
              ),
            },
            {
              id: "equipe",
              rotulo: "Equipe",
              icone: <Users size={14} aria-hidden />,
              contador: colegasAlcancaveis,
              conteudo: (
                <EquipeDoAgente
                  agenteId={agente.id}
                  agenteKey={agente.key}
                  ehEntrada={agente.isEntry}
                  temDescricaoDeRoteamento={temRoteamento}
                  colegas={colegas}
                  editavel={editavel}
                />
              ),
            },
            {
              id: "integracoes",
              rotulo: "Integrações",
              icone: <Plug size={14} aria-hidden />,
              contador: integracoesLigadas,
              conteudo: (
                <IntegracoesDoAgente
                  agentId={agente.id}
                  editavel={editavel}
                  integracoes={integracoesDisponiveis}
                />
              ),
            },
            {
              id: "historico",
              rotulo: "Histórico",
              icone: <History size={14} aria-hidden />,
              conteudo: (
                <>
                  <Card className="space-y-3">
                    <h2 className="text-sm font-semibold">
                      Histórico de versões
                    </h2>
                    <p className="text-xs text-muted">
                      Uma versão nova é criada quando muda o prompt, o modelo ou
                      o effort. Editar nome ou descrição não versiona.
                    </p>
                    <ul className="space-y-2 text-sm">
                      {agente.versions.map((versao) => (
                        <li
                          key={versao.id}
                          className="flex items-baseline gap-2"
                        >
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
                </>
              ),
            },
          ]}
        />

        {/* Fora das abas de propósito: dá para testar enquanto se mexe em
            qualquer configuração, que é como o playground é usado. */}
        <div className="xl:sticky xl:top-8 xl:self-start">
          <Playground agentId={agente.id} agenteAtivo={agente.active} />
        </div>
      </div>
    </div>
  );
}
