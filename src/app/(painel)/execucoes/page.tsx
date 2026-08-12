import { ScrollText } from "lucide-react";
import { db } from "@/lib/db";
import { exigirSessao } from "@/server/auth-guard";
import { IntegrationProvider, RunStatus } from "@/generated/prisma/enums";
import { chatwootConfigSchema } from "@/server/integrations/chatwoot/config";
import {
  montarWhere,
  normalizarFonte,
  opcoesDeFiltro,
  ROTULO_DA_FONTE,
} from "@/server/consumo/consulta";
import { intervaloDoPeriodo, normalizarPeriodo } from "@/server/consumo/periodo";
import { Execucao } from "@/components/execucao";
import { Filtros, type Campo } from "@/components/filtros";
import { EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

type Busca = {
  periodo?: string;
  agente?: string;
  modelo?: string;
  fonte?: string;
  status?: string;
  quantidade?: string;
};

const QUANTIDADES = ["50", "100", "200"] as const;

/**
 * Trace de execuções. É esta tela que responde "por que o bot respondeu isso?".
 *
 * A lista carrega só o resumo de cada execução; o conteúdo pesado — transcrição
 * enviada ao modelo, parâmetros e retorno de cada tool — desce sob demanda
 * quando o cartão é expandido. Ver `detalharExecucao`.
 */
export default async function ExecucoesPage({
  searchParams,
}: {
  searchParams: Promise<Busca>;
}) {
  const busca = await searchParams;
  await exigirSessao();

  // Sem período escolhido, mostra o histórico inteiro: aqui a pergunta costuma
  // ser "o que aconteceu agora há pouco", e um recorte de data por padrão
  // esconderia a execução que a pessoa veio investigar.
  const intervalo = busca.periodo
    ? intervaloDoPeriodo(normalizarPeriodo(busca.periodo))
    : intervaloDoPeriodo("tudo");

  const status =
    busca.status && busca.status in RunStatus
      ? (busca.status as RunStatus)
      : null;

  const quantidade = (QUANTIDADES as readonly string[]).includes(
    busca.quantidade ?? "",
  )
    ? Number(busca.quantidade)
    : 50;

  const where = {
    ...montarWhere({
      intervalo,
      agentId: busca.agente ?? null,
      model: busca.modelo ?? null,
      source: normalizarFonte(busca.fonte),
    }),
    ...(status ? { status } : {}),
  };

  const [execucoes, opcoes, integracao] = await Promise.all([
    db.agentRun.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: quantidade,
      // Select explícito: sem ele o Prisma traz `messages`, que guarda a
      // conversa inteira mandada ao modelo. Cinquenta transcrições completas
      // atravessavam a rede a cada abertura da tela para não aparecer nenhuma.
      select: {
        id: true,
        status: true,
        source: true,
        model: true,
        createdAt: true,
        latencyMs: true,
        costUsd: true,
        inputTokens: true,
        outputTokens: true,
        input: true,
        output: true,
        error: true,
        agent: { select: { id: true, name: true } },
        conversation: { select: { chatwootConversationId: true } },
        toolCalls: { select: { toolName: true, isError: true } },
      },
    }),
    opcoesDeFiltro(),
    db.integration.findUnique({
      where: { provider: IntegrationProvider.CHATWOOT },
    }),
  ]);

  const config = chatwootConfigSchema.safeParse(integracao?.config ?? {});
  const linkDaConversa = (id: number | undefined | null) =>
    config.success && id
      ? `${config.data.baseUrl}/app/accounts/${config.data.accountId}/conversations/${id}`
      : null;

  const campos: Campo[] = [
    {
      tipo: "select",
      chave: "periodo",
      rotulo: "Período",
      opcoes: [
        { valor: "", rotulo: "Qualquer data" },
        { valor: "hoje", rotulo: "Hoje" },
        { valor: "ontem", rotulo: "Ontem" },
        { valor: "7d", rotulo: "7 dias" },
        { valor: "30d", rotulo: "30 dias" },
      ],
    },
    {
      tipo: "select",
      chave: "agente",
      rotulo: "Agente",
      opcoes: [
        { valor: "", rotulo: "Todos" },
        ...opcoes.agentes.map((a) => ({
          valor: a.id,
          rotulo: a.arquivado ? `${a.nome} (arquivado)` : a.nome,
        })),
      ],
    },
    {
      tipo: "select",
      chave: "modelo",
      rotulo: "Modelo",
      opcoes: [
        { valor: "", rotulo: "Todos" },
        ...opcoes.modelos.map((m) => ({ valor: m, rotulo: m })),
      ],
    },
    {
      tipo: "select",
      chave: "fonte",
      rotulo: "Origem",
      opcoes: [
        { valor: "", rotulo: "Todas" },
        ...Object.entries(ROTULO_DA_FONTE).map(([valor, rotulo]) => ({
          valor,
          rotulo,
        })),
      ],
    },
    {
      tipo: "segmento",
      chave: "status",
      rotulo: "Resultado",
      opcoes: [
        { valor: "", rotulo: "Todos" },
        { valor: RunStatus.SUCCESS, rotulo: "Sucesso" },
        { valor: RunStatus.ERROR, rotulo: "Erro" },
        { valor: RunStatus.RUNNING, rotulo: "Rodando" },
      ],
    },
    {
      tipo: "select",
      chave: "quantidade",
      rotulo: "Mostrar",
      opcoes: QUANTIDADES.map((q) => ({ valor: q, rotulo: `${q} últimas` })),
    },
  ];

  const filtrado = Object.entries(busca).some(([, v]) => Boolean(v));

  return (
    <div className="space-y-6">
      <PageHeader
        titulo="Execuções"
        descricao="Cada resposta gerada, com tokens, custo e tools chamadas. Abra uma execução para ler a entrada e a resposta inteiras, o que cada tool recebeu e devolveu, e a transcrição que foi enviada ao modelo."
      />

      <Filtros campos={campos} valores={busca} />

      {execucoes.length === 0 ? (
        <EmptyState
          icone={<ScrollText size={18} aria-hidden />}
          titulo={
            filtrado
              ? "Nenhuma execução com esses filtros"
              : "Nenhuma execução ainda"
          }
          descricao={
            filtrado
              ? "Tire um filtro ou amplie o período."
              : "Use o playground de um agente para gerar a primeira."
          }
        />
      ) : (
        <div className="space-y-2">
          {execucoes.map((e) => (
            <Execucao
              key={e.id}
              linkDaConversa={linkDaConversa(
                e.conversation?.chatwootConversationId,
              )}
              resumo={{
                id: e.id,
                status: e.status,
                source: e.source,
                model: e.model,
                createdAt: e.createdAt,
                latencyMs: e.latencyMs,
                costUsd: Number(e.costUsd ?? 0),
                inputTokens: e.inputTokens,
                outputTokens: e.outputTokens,
                input: e.input,
                output: e.output,
                error: e.error,
                agente: { id: e.agent.id, nome: e.agent.name },
                tools: e.toolCalls,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
