import Link from "next/link";
import {
  AlertTriangle,
  Bot,
  CalendarRange,
  Cpu,
  Download,
  Radio,
  Wallet,
} from "lucide-react";
import { db } from "@/lib/db";
import { exigirSessao } from "@/server/auth-guard";
import { listarModelos } from "@/server/agents/catalogo";
import {
  agregar,
  SEM_MODELO,
  type Fatia,
} from "@/server/consumo/agregacao";
import {
  normalizarFonte,
  opcoesDeFiltro,
  ROTULO_DA_FONTE,
  TETO_DE_LINHAS,
  varrerPeriodo,
} from "@/server/consumo/consulta";
import {
  diasDoIntervalo,
  intervaloDoPeriodo,
  normalizarPeriodo,
  PERIODOS,
  ROTULO_DO_PERIODO,
} from "@/server/consumo/periodo";
import { diaEmSaoPaulo } from "@/lib/tempo";
import { Filtros, type Campo } from "@/components/filtros";
import { GraficoDiario } from "@/components/consumo/grafico-diario";
import {
  Aviso,
  Barra,
  Card,
  EmptyState,
  PageHeader,
  Stat,
  Tabela,
  TituloDeBloco,
} from "@/components/ui";
import {
  formatarNumero,
  formatarUsd,
  formatarDuracao,
} from "@/lib/utils";

export const dynamic = "force-dynamic";

type Busca = {
  periodo?: string;
  de?: string;
  ate?: string;
  agente?: string;
  modelo?: string;
  fonte?: string;
};

/**
 * Apuração de consumo: quanto se gastou, com qual modelo, por qual agente e em
 * que dia.
 *
 * O custo vem de `AgentRun.costUsd`, que é o valor **real** devolvido pela
 * OpenRouter em `usage.cost` — não uma estimativa por tabela de preço. Por isso
 * esta tela pode ser conferida contra a fatura deles.
 */
export default async function ConsumoPage({
  searchParams,
}: {
  searchParams: Promise<Busca>;
}) {
  const busca = await searchParams;
  await exigirSessao();

  const periodo = normalizarPeriodo(busca.periodo);
  const intervalo = intervaloDoPeriodo(periodo, {
    de: busca.de,
    ate: busca.ate,
  });
  const fonte = normalizarFonte(busca.fonte);

  const [opcoes, resultado, execucoesNoHistorico] = await Promise.all([
    opcoesDeFiltro(),
    varrerPeriodo({
      intervalo,
      agentId: busca.agente ?? null,
      model: busca.modelo ?? null,
      source: fonte,
    }),
    db.agentRun.count(),
  ]);

  const campos: Campo[] = [
    {
      tipo: "segmento",
      chave: "periodo",
      rotulo: "Período",
      opcoes: PERIODOS.map((p) => ({ valor: p, rotulo: ROTULO_DO_PERIODO[p] })),
    },
    ...(periodo === "custom"
      ? ([
          { tipo: "data", chave: "de", rotulo: "De" },
          { tipo: "data", chave: "ate", rotulo: "Até" },
        ] as Campo[])
      : []),
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
        ...(opcoes.temSemModelo
          ? [{ valor: SEM_MODELO, rotulo: "Sem modelo registrado" }]
          : []),
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
  ];

  const parametrosDoCsv = new URLSearchParams();
  for (const [chave, valor] of Object.entries(busca)) {
    if (valor) parametrosDoCsv.set(chave, valor);
  }

  const filtros = (
    <Filtros
      campos={campos}
      valores={busca}
      acoes={
        <Link
          href={`/api/consumo/csv?${parametrosDoCsv.toString()}`}
          prefetch={false}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-xs font-medium transition hover:border-accent/40 hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Download size={13} aria-hidden />
          Exportar CSV
        </Link>
      }
    />
  );

  const cabecalho = (
    <PageHeader
      titulo="Consumo"
      descricao="Quanto os agentes custaram no período, por modelo, por agente e por origem. O valor é o custo real cobrado pela OpenRouter em cada chamada, não uma estimativa — dá para conferir contra a fatura."
    />
  );

  if (resultado.excedeu) {
    return (
      <div className="space-y-6">
        {cabecalho}
        {filtros}
        <Aviso tone="warning">
          O período escolhido tem{" "}
          <strong>{formatarNumero(resultado.total)} execuções</strong>, acima do
          teto de {formatarNumero(TETO_DE_LINHAS)} que esta tela apura de uma
          vez. Escolha um intervalo menor ou filtre por agente — melhor pedir um
          recorte do que mostrar um total incompleto que parece certo.
        </Aviso>
      </div>
    );
  }

  const { linhas } = resultado;
  const primeiroDiaComDados = linhas[0]
    ? diaEmSaoPaulo(linhas[0].createdAt)
    : null;
  const apuracao = agregar(linhas, diasDoIntervalo(intervalo, primeiroDiaComDados));
  const { totais } = apuracao;

  const nomeDoAgente = new Map(opcoes.agentes.map((a) => [a.id, a.nome]));
  const catalogo = await listarModelos();
  const nomeDoModelo = new Map(catalogo.map((m) => [m.id, m.nome]));

  if (totais.execucoes === 0) {
    return (
      <div className="space-y-6">
        {cabecalho}
        {filtros}
        <EmptyState
          icone={<CalendarRange size={18} aria-hidden />}
          titulo={`Nenhuma execução ${intervalo.rotulo}`}
          descricao="Troque o período ou tire os filtros. Execuções de playground também entram aqui — elas custam igual."
        />
      </div>
    );
  }

  /** Uma quebra: tabela ordenada por custo, com a parcela desenhada na linha. */
  function quebra(
    fatias: Fatia[],
    rotularChave: (chave: string) => React.ReactNode,
  ) {
    return (
      <Tabela
        cabecalho={
          <>
            <th scope="col">Nome</th>
            <th scope="col" className="w-28">Parcela</th>
            <th scope="col" className="text-right">Custo</th>
            <th scope="col" className="text-right">Execuções</th>
            <th scope="col" className="text-right">Tokens</th>
            <th scope="col" className="text-right">Média/exec.</th>
          </>
        }
      >
        {fatias.map((f) => (
          <tr key={f.chave}>
            <td className="min-w-0">{rotularChave(f.chave)}</td>
            <td>
              <span className="flex items-center gap-2">
                <Barra
                  fracao={f.parcela}
                  titulo={`${(f.parcela * 100).toFixed(1)}% do custo`}
                />
                <span className="w-9 shrink-0 text-right text-[11px] text-muted tabular-nums">
                  {(f.parcela * 100).toFixed(0)}%
                </span>
              </span>
            </td>
            <td className="text-right font-medium tabular-nums">
              {formatarUsd(f.custoUsd)}
            </td>
            <td className="text-right tabular-nums">
              {formatarNumero(f.execucoes)}
              {f.erros > 0 ? (
                <span className="ml-1 text-danger" title={`${f.erros} com erro`}>
                  ({f.erros} erro)
                </span>
              ) : null}
            </td>
            <td className="text-right tabular-nums">
              {formatarNumero(f.tokens)}
            </td>
            <td className="text-right text-muted tabular-nums">
              {formatarUsd(f.custoMedioPorExecucao)}
            </td>
          </tr>
        ))}
      </Tabela>
    );
  }

  return (
    <div className="space-y-6">
      {cabecalho}
      {filtros}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          rotulo={`Custo ${intervalo.rotulo}`}
          valor={formatarUsd(totais.custoUsd)}
          detalhe={`${formatarNumero(totais.execucoes)} execuções · média de ${formatarUsd(
            totais.custoMedioPorExecucao,
          )} por execução`}
          destaque
          className="sm:col-span-2"
        />
        <Stat
          rotulo="Custo por atendimento"
          valor={
            totais.custoPorConversa == null
              ? "—"
              : formatarUsd(totais.custoPorConversa)
          }
          detalhe={
            totais.conversas > 0
              ? `${formatarNumero(totais.conversas)} conversas atendidas`
              : "Nenhuma conversa no período — só playground ou gatilho."
          }
        />
        <Stat
          rotulo="Tokens"
          valor={formatarNumero(totais.tokens)}
          detalhe={`${formatarNumero(totais.tokensEntrada)} de entrada · ${formatarNumero(
            totais.tokensSaida,
          )} de saída · ${formatarNumero(totais.tokensCache)} lidos do cache`}
        />
      </div>

      {totais.erros > 0 ? (
        <Aviso tone="danger">
          <strong>
            {formatarNumero(totais.erros)} de{" "}
            {formatarNumero(totais.execucoes)} execuções falharam
          </strong>{" "}
          no período — e continuam contadas no custo, porque a OpenRouter cobra
          os tokens gastos até a falha. O detalhe de cada uma está em{" "}
          <Link href="/execucoes?status=ERROR" className="underline">
            Execuções
          </Link>
          .
        </Aviso>
      ) : null}

      <Card className="space-y-4">
        <TituloDeBloco
          icone={<Wallet size={15} aria-hidden />}
          descricao={`Latência média de ${formatarDuracao(totais.latenciaMediaMs)} por execução.`}
        >
          Consumo por dia
        </TituloDeBloco>
        <GraficoDiario pontos={apuracao.porDia} />
      </Card>

      <Card className="space-y-3">
        <TituloDeBloco
          icone={<Cpu size={15} aria-hidden />}
          descricao="O modelo é o que estava configurado no momento de cada execução — trocar de modelo hoje não reescreve o gasto de ontem."
        >
          Por modelo
        </TituloDeBloco>
        {quebra(apuracao.porModelo, (chave) =>
          chave === SEM_MODELO ? (
            <span
              className="text-muted"
              title="Execuções anteriores ao registro do modelo, de agentes sem histórico de versão."
            >
              Sem modelo registrado
            </span>
          ) : (
            <span className="block min-w-0">
              <span className="block truncate text-[13px]">
                {nomeDoModelo.get(chave) ?? chave}
              </span>
              <span className="block truncate font-mono text-[11px] text-muted">
                {chave}
              </span>
            </span>
          ),
        )}
      </Card>

      <Card className="space-y-3">
        <TituloDeBloco icone={<Bot size={15} aria-hidden />}>
          Por agente
        </TituloDeBloco>
        {quebra(apuracao.porAgente, (chave) => (
          <Link href={`/agentes/${chave}`} className="text-[13px] hover:underline">
            {nomeDoAgente.get(chave) ?? "Agente removido"}
          </Link>
        ))}
      </Card>

      <Card className="space-y-3">
        <TituloDeBloco
          icone={<Radio size={15} aria-hidden />}
          descricao="Playground é teste e custa igual — vale separar antes de fechar o mês."
        >
          Por origem
        </TituloDeBloco>
        {quebra(apuracao.porFonte, (chave) => (
          <span className="text-[13px]">
            {ROTULO_DA_FONTE[chave as keyof typeof ROTULO_DA_FONTE] ?? chave}
          </span>
        ))}
      </Card>

      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
        <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
        <span>
          Execução ainda em andamento aparece com custo zero até terminar. Há{" "}
          {formatarNumero(execucoesNoHistorico)} execuções guardadas no total.
        </span>
      </p>
    </div>
  );
}
