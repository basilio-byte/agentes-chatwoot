import Link from "next/link";
import { Archive, Bot, Cpu, Plus } from "lucide-react";
import { db } from "@/lib/db";
import { exigirSessao, podeEditar } from "@/server/auth-guard";
import { alternarAtivo } from "@/server/actions/agents";
import {
  Aviso,
  Badge,
  Button,
  Card,
  EmptyState,
  Meta,
  PageHeader,
  BOTAO_PRIMARIO,
  Ponto,
} from "@/components/ui";
import { Abas } from "@/components/abas";
import { AcoesDoAgente } from "@/components/acoes-do-agente";
import { SeletorDeEntrada } from "@/components/seletor-de-entrada";
import { formatarData } from "@/lib/utils";
import { Recolhivel } from "@/components/recolhivel";
import { MotorDosAgentesForm } from "@/components/motor";
import {
  claudeMaxConfigurado,
  lerMotorGlobal,
  listarModelosClaudeMax,
} from "@/server/agents/claude-max";
import { resolverMotor } from "@/server/agents/motor";

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

  // O motor que vale para cada agente AGORA, pela mesma função do runner: a
  // tela dizer um motor e o turno usar outro é a divergência que ela evita.
  const configurado = claudeMaxConfigurado();
  const motorGlobal = await lerMotorGlobal();
  // Sem proxy configurado ela devolve a lista de reserva sem ir à rede.
  const catalogoClaude = await listarModelosClaudeMax();
  const motorDe = (agente: (typeof agentes)[number]) =>
    resolverMotor({
      motorDoAgente: agente.motor,
      modeloDoAgente: agente.modeloClaudeMax,
      chaveGeralLigada: motorGlobal.claudeMaxLigado,
      modeloPadrao: motorGlobal.modeloPadrao,
      proxyConfigurado: configurado,
    });

  const ativos = agentes.filter((a) => !a.archivedAt);
  const arquivados = agentes.filter((a) => a.archivedAt);

  function cartao(agente: (typeof agentes)[number]) {
    const arquivado = Boolean(agente.archivedAt);
    const motor = motorDe(agente);

    return (
      <Card
        key={agente.id}
        className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4"
      >
        <div className="min-w-0 flex-1 space-y-1">
          {/* O ponto vive na linha do nome: centrado no cartão, ele caía no
              vão entre as duas linhas de texto e não pertencia a nenhuma. */}
          <div className="flex flex-wrap items-center gap-2">
            <Ponto ligado={agente.active} />
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
            {motor.motor === "CLAUDE_MAX" ? (
              <Badge tone="accent" title={motor.porque}>
                Claude MAX
              </Badge>
            ) : null}
            {agente.inboxMode === "specific" && agente.inboxIds.length > 0 ? (
              <Badge title="Caixas de entrada em que atua">
                caixa{agente.inboxIds.length > 1 ? "s" : ""}{" "}
                {agente.inboxIds.join(", ")}
              </Badge>
            ) : null}
          </div>

          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px] text-muted">
            <span className="truncate">
              {agente.description || "Sem descrição"}
            </span>
            <span className="truncate font-mono text-xs" title={motor.porque}>
              {motor.motor === "CLAUDE_MAX" ? motor.modeloClaude : agente.model}
            </span>
          </p>
        </div>

        <div className="space-y-0.5 text-right">
          <Meta
            className="block"
            title="Conversas que este agente já atendeu, e quantas vezes ele rodou"
          >
            {agente._count.runs} execuç{agente._count.runs === 1 ? "ão" : "ões"}{" "}
            · {conversasPorAgente.get(agente.id) ?? 0} conversa
            {(conversasPorAgente.get(agente.id) ?? 0) === 1 ? "" : "s"}
          </Meta>
          <Meta
            className="block"
            title={`Dono: ${agente.owner?.name ?? "—"} · última alteração por ${agente.updatedBy?.name ?? "—"}`}
          >
            {arquivado && agente.archivedAt
              ? `arquivado em ${formatarData(agente.archivedAt)}`
              : `alterado em ${formatarData(agente.updatedAt)}`}
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

  const noClaudeMax = ativos.filter((a) => motorDe(a).motor === "CLAUDE_MAX").length;
  const blocoDoMotor = (
    <Recolhivel
      titulo="Motor dos agentes"
      icone={<Cpu size={15} aria-hidden />}
      estado={
        motorGlobal.claudeMaxLigado && configurado ? (
          <Badge tone="accent">Claude MAX</Badge>
        ) : (
          <Badge>OpenRouter</Badge>
        )
      }
      resumo={
        configurado
          ? `${noClaudeMax} de ${ativos.length} agentes no Claude MAX`
          : "proxy Claude MAX não configurado"
      }
    >
      <p className="text-[13px] leading-relaxed text-muted">
        Por onde os agentes pensam: a <strong>OpenRouter</strong> (cobrada por
        token) ou o <strong>proxy Claude MAX</strong> (a assinatura, sem custo
        por token, dentro da cota do plano). A chave geral vale para todo agente
        que a segue; na tela de cada agente dá para fixar um motor, que é como
        se testa num agente só. Se o proxy falhar — cota, fila, fora do ar —, a
        chamada volta sozinha para a OpenRouter, com o modelo que o agente já
        tem lá, e a execução registra a volta.
      </p>
      {configurado ? null : (
        <Aviso tone="neutral">
          O proxy não está configurado, e todos os agentes rodam na OpenRouter,
          como sempre. Para usar, defina no Easypanel{" "}
          <code>CLAUDE_MAX_BASE_URL</code> (a base OpenAI do proxy, terminando
          em <code>/v1</code>) e <code>CLAUDE_MAX_API_KEY</code> (uma das chaves
          do proxy).
        </Aviso>
      )}
      {configurado && !catalogoClaude.doProxy ? (
        <Aviso tone="warning">
          Não consegui ler a lista de modelos do proxy agora — a lista abaixo é
          a de reserva. Confira se ele está no ar.
        </Aviso>
      ) : null}
      <MotorDosAgentesForm
        ligado={motorGlobal.claudeMaxLigado}
        modeloPadrao={motorGlobal.modeloPadrao}
        modelos={catalogoClaude.modelos.map((m) => ({ id: m.id, nome: m.nome }))}
        configurado={configurado}
        somenteLeitura={!editavel}
      />
      <p className="text-xs leading-relaxed text-muted">
        No Claude MAX, o esforço de raciocínio de cada agente não vale: quem
        manda é a configuração do proxy. E a execução aparece em Consumo com
        custo zero — a assinatura não cobra por token.
      </p>
    </Recolhivel>
  );

  const criar = editavel ? (
    <Link
      href="/agentes/novo"
      className={BOTAO_PRIMARIO}
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
                <div className="space-y-4">
                  {blocoDoMotor}
                  <div className="space-y-2">{ativos.map(cartao)}</div>
                </div>
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
