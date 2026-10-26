import { notFound } from "next/navigation";
import {
  CalendarClock,
  Cpu,
  Gauge,
  History,
  Layers,
  OctagonX,
  Settings2,
  Users,
} from "lucide-react";
import { UserRole } from "@/generated/prisma/enums";
import { exigirSessao } from "@/server/auth-guard";
import { alcancaPapel } from "@/lib/papeis";
import { diaEmSaoPaulo } from "@/lib/tempo";
import { compactar } from "@/server/consumo/agregacao";
import {
  diasDoIntervalo,
  intervaloDoPeriodo,
  normalizarPeriodo,
  PERIODOS,
  ROTULO_DO_PERIODO,
} from "@/server/consumo/periodo";
import { tokensProcessados, type Totais } from "@/server/openclaws/agregacao";
import { NOMES_DOS_DIAS } from "@/server/openclaws/config";
import { lerConfig, lerHistorico, TETO_DE_LINHAS } from "@/server/openclaws/consulta";
import { duracaoEmHoras, haQuanto, percentual, usd } from "@/server/openclaws/formato";
import { montarPanorama } from "@/server/openclaws/panorama";
import { Filtros, type Campo } from "@/components/filtros";
import { GraficoDiario } from "@/components/consumo/grafico-diario";
import { OpenClawsConfigForm, TokenDoColetor } from "@/components/openclaws-config";
import { Recolhivel } from "@/components/recolhivel";
import {
  Aviso,
  Badge,
  Barra,
  Card,
  EmptyState,
  Meta,
  PageHeader,
  Stat,
  Tabela,
  TituloDeBloco,
} from "@/components/ui";
import { formatarData, formatarNumero } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Coleta a cada 2 h: passando disto sem lote novo, a tela avisa que parou. */
const COLETA_ATRASADA_EM_HORAS = 5;

type Busca = { periodo?: string; de?: string; ate?: string };

/** `domingo, 25/10 16:00` — o instante, no relógio de São Paulo. */
const quando = (d: Date) => formatarData(d);

/** Os tokens de uma linha, com a divisão no título para quem quiser conferir. */
const tokens = (t: Totais) => (
  <span
    title={`${formatarNumero(t.entrada)} de entrada · ${formatarNumero(t.saida)} de saída · ${formatarNumero(t.cacheLeitura)} de cache lido · ${formatarNumero(t.cacheEscrita)} de cache escrito`}
  >
    {compactar(tokensProcessados(t))}
  </span>
);

/**
 * OpenClaws: quanto cada um gasta da cota semanal da conta Claude.
 *
 * ⚠ **Só Proprietário**, e 404 para os outros (pedido do usuário em
 * 26/10/2026, e a mesma doutrina de `/prazos`): é uma medida por pessoa, e o
 * painel é aberto à equipe inteira — inclusive a quem está sendo medido.
 *
 * ⚠ **Os US$ desta tela são o custo EQUIVALENTE**: a tarifa pública da API
 * aplicada ao que cada OpenClaw consumiu. Eles gastam de uma assinatura, que não
 * cobra por token, e a Anthropic não publica o peso da cota — então o número é
 * uma régua para comparar pessoas, modelos e semanas, não uma fatura. A cota em
 * si é estimada pelos bloqueios (ver `openclaws/calibragem.ts`).
 *
 * Os dados chegam do coletor que roda no servidor dos OpenClaws
 * (`/api/ingestao/openclaws`); esta página só lê.
 */
export default async function OpenClawsPage({
  searchParams,
}: {
  searchParams: Promise<Busca>;
}) {
  const busca = await searchParams;
  const sessao = await exigirSessao();
  if (!alcancaPapel(sessao.user.role, UserRole.OWNER)) notFound();

  const agora = new Date();
  const periodo = normalizarPeriodo(busca.periodo);
  const intervalo = intervaloDoPeriodo(periodo, { de: busca.de, ate: busca.ate }, agora);

  const [config, historico] = await Promise.all([lerConfig(), lerHistorico()]);

  const cabecalho = (
    <PageHeader
      titulo="OpenClaws"
      descricao={
        <>
          Quanto cada OpenClaw da equipe gasta da <strong>cota semanal</strong> da
          conta Claude. Os valores em US$ são o <strong>custo equivalente</strong>{" "}
          (a tarifa de API aplicada ao que foi consumido): uma régua para comparar
          pessoas e semanas, não a fatura — a assinatura não cobra por token.
        </>
      }
      acoes={<Badge tone="accent">só Proprietário</Badge>}
    />
  );

  const configuracao = (
    <Recolhivel
      titulo="Configuração e coletor"
      icone={<Settings2 size={15} aria-hidden />}
      estado={
        <Badge tone={config.temToken ? "success" : "warning"}>
          {config.temToken ? "coletor com token" : "sem token"}
        </Badge>
      }
      resumo="Nomes, conta compartilhada, cota e o token do coletor."
      padraoAberto={!config.temToken}
    >
      <div className="space-y-6">
        <section className="space-y-2">
          <TituloDeBloco descricao="O coletor roda no servidor dos OpenClaws, lê o uso de cada um e envia para cá a cada 2 horas.">
            Token do coletor
          </TituloDeBloco>
          <TokenDoColetor temToken={config.temToken} dica={config.tokenDica} />
        </section>

        <section className="space-y-2">
          <TituloDeBloco descricao="O nome mora aqui, no banco — o coletor só conhece o id do contêiner.">
            Quem é quem, e a cota
          </TituloDeBloco>
          <OpenClawsConfigForm
            conteineres={config.conteineres}
            cotaManual={config.cotaManualUsd}
            resetDia={config.reset.diaSemana}
            resetHora={config.reset.horaUtc}
          />
        </section>
      </div>
    </Recolhivel>
  );

  if (historico.linhas.length === 0) {
    return (
      <div className="space-y-6">
        {cabecalho}
        <EmptyState
          icone={<Gauge size={18} aria-hidden />}
          titulo="O coletor ainda não enviou nada"
          descricao={
            config.temToken
              ? "O token existe, mas nenhum lote chegou. Confira se o coletor está instalado e rodando no servidor dos OpenClaws."
              : "Gere o token abaixo e instale o coletor no servidor dos OpenClaws. Na primeira coleta, o histórico inteiro de cada OpenClaw entra de uma vez."
          }
        />
        {configuracao}
      </div>
    );
  }

  const primeiroDiaComDados = diaEmSaoPaulo(
    historico.linhas.reduce((min, l) => (l.hora < min ? l.hora : min), historico.linhas[0].hora),
  );
  const dias = diasDoIntervalo(intervalo, primeiroDiaComDados);

  const p = montarPanorama({
    agora,
    linhas: historico.linhas,
    limites: historico.limites,
    conteineres: config.conteineres,
    reset: config.reset,
    cotaManualUsd: config.cotaManualUsd,
    periodo: { inicio: intervalo.inicio, fim: intervalo.fim },
    dias,
  });

  const campos: Campo[] = [
    {
      tipo: "segmento",
      chave: "periodo",
      rotulo: "Período",
      opcoes: PERIODOS.map((x) => ({ valor: x, rotulo: ROTULO_DO_PERIODO[x] })),
    },
    ...(periodo === "custom"
      ? ([
          { tipo: "data", chave: "de", rotulo: "De" },
          { tipo: "data", chave: "ate", rotulo: "Até" },
        ] as Campo[])
      : []),
  ];

  const nomeDe = (id: string) => p.pessoas.find((x) => x.conteiner === id)?.nome ?? id;
  const maiorDoCiclo = Math.max(0, ...p.pessoas.map((x) => x.ciclo.usd));

  const coletaAtrasada =
    config.ultimaColetaEm &&
    agora.getTime() - config.ultimaColetaEm.getTime() > COLETA_ATRASADA_EM_HORAS * 3_600_000;

  const bloqueioEmCurso = p.bloqueios.find((b) => b.emCurso);
  const amostraDoBloqueio = (inicio: Date) =>
    p.cota.detalhe.find((d) => d.bloqueioInicio.getTime() === inicio.getTime());

  const diaDoReset = NOMES_DOS_DIAS[config.reset.diaSemana];

  return (
    <div className="space-y-6">
      {cabecalho}

      {historico.cortado ? (
        <Aviso tone="warning">
          O histórico passou de <strong>{formatarNumero(TETO_DE_LINHAS)} linhas</strong>,
          acima do que esta tela soma de uma vez. Os números abaixo cobrem só o
          trecho mais recente e podem estar incompletos — melhor avisar do que
          mostrar uma cota que parece folgada.
        </Aviso>
      ) : null}

      {coletaAtrasada && config.ultimaColetaEm ? (
        <Aviso tone="warning">
          A última coleta chegou <strong>{haQuanto(config.ultimaColetaEm, agora)}</strong>{" "}
          ({quando(config.ultimaColetaEm)}). Os números podem estar atrasados —
          confira o coletor no servidor dos OpenClaws.
        </Aviso>
      ) : null}

      {bloqueioEmCurso ? (
        <Aviso tone="danger">
          <strong>A conta está bloqueada por cota desde {quando(bloqueioEmCurso.inicio)}.</strong>{" "}
          Os OpenClaws de {bloqueioEmCurso.conteineres.map(nomeDe).join(", ")} estão
          recebendo recusa da Anthropic e não respondem. A cota volta no próximo
          reset: {diaDoReset}, {quando(p.proximoReset)}.
        </Aviso>
      ) : p.projecao?.acabaEm ? (
        <Aviso tone="warning">
          <strong>No ritmo desta semana a cota acaba em {quando(p.projecao.acabaEm)}</strong>,
          antes do reset ({quando(p.proximoReset)}). Ver quem mais gasta na tabela
          abaixo.
        </Aviso>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          rotulo="Cota usada nesta semana"
          valor={p.cota.usd ? percentual(p.doCiclo.fracaoDaCota) : "—"}
          destaque
          detalhe={
            p.cota.usd ? (
              <span className="block space-y-1.5">
                <Barra
                  fracao={p.doCiclo.fracaoDaCota ?? 0}
                  titulo={`${usd(p.doCiclo.totais.usd)} de ${usd(p.cota.usd)}`}
                />
                <span className="block">
                  {usd(p.doCiclo.totais.usd)} de ~{usd(p.cota.usd)}
                  {p.cota.origem === "manual"
                    ? " (cota informada)"
                    : ` (estimada por ${p.cota.amostras} bloqueio${p.cota.amostras === 1 ? "" : "s"})`}
                </span>
              </span>
            ) : (
              <>
                {usd(p.doCiclo.totais.usd)} gastos nesta semana. A cota ainda
                não foi medida: ela aparece depois do primeiro bloqueio, ou informe
                uma em Configuração.
              </>
            )
          }
        />
        <Stat
          rotulo="A cota recomeça"
          valor={quando(p.proximoReset)}
          detalhe={`${diaDoReset}, horário de São Paulo. A semana atual começou em ${quando(p.cicloAtual.inicio)}.`}
        />
        <Stat
          rotulo="Ritmo da semana"
          valor={p.projecao ? `${usd(p.projecao.usdPorHora * 24)}/dia` : "—"}
          detalhe={
            p.projecao
              ? p.projecao.acabaEm
                ? `Se mantiver, a cota acaba em ${quando(p.projecao.acabaEm)}.`
                : p.cota.usd
                  ? "No ritmo atual a cota dura até o reset."
                  : "Sem cota medida, não dá para prever quando acaba."
              : "Poucas horas de dado nesta semana para projetar."
          }
        />
        <Stat
          rotulo="Horas bloqueadas (últimas 4 semanas)"
          valor={duracaoEmHoras(
            p.historico.slice(0, 4).reduce((s, c) => s + c.horasBloqueadas, 0),
          )}
          detalhe={
            p.bloqueios.length > 0
              ? `${p.bloqueios.length} bloqueio${p.bloqueios.length === 1 ? "" : "s"} no histórico; o último começou em ${quando(p.bloqueios[0].inicio)}.`
              : "Nenhum bloqueio por cota no histórico."
          }
        />
      </div>

      <Filtros campos={campos} valores={busca} />

      {/* Uma linha por pessoa. A barra mostra a fatia da COTA da semana (e, sem
          cota medida, a fatia do que a conta gastou). O Guilherme aparece com o
          consumo dele, marcado: a credencial dele é outra. */}
      <section className="space-y-3">
        <TituloDeBloco
          icone={<Users size={15} aria-hidden />}
          descricao={`"Esta semana" é o ciclo da cota, que não muda com o filtro; "no período" segue o filtro (${intervalo.rotulo}).`}
        >
          Quanto cada pessoa gasta
        </TituloDeBloco>

        <Tabela
          cabecalho={
            <>
              <th scope="col">Pessoa</th>
              <th scope="col" className="w-56">
                Esta semana
              </th>
              <th scope="col" className="text-right">
                Parte da conta
              </th>
              <th scope="col" className="text-right">
                No período
              </th>
              <th scope="col" className="text-right">
                Chamadas
              </th>
              <th scope="col" className="text-right">
                Tokens
              </th>
            </>
          }
        >
          {p.pessoas.map((pessoa) => (
            <tr key={pessoa.conteiner}>
              <td className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{pessoa.nome}</span>
                  <Meta className="font-mono text-[11px]">{pessoa.conteiner}</Meta>
                  {pessoa.compartilhada ? null : (
                    <Badge title="Credencial própria: não divide a cota dos outros">
                      conta própria
                    </Badge>
                  )}
                </span>
              </td>
              <td>
                {/* Valor e percentual na mesma linha, a barra embaixo: o
                    percentual solto ao lado da barra flutuava fora do eixo. */}
                <span className="flex items-baseline justify-between gap-3 text-xs tabular-nums">
                  <span className="text-muted">{usd(pessoa.ciclo.usd)}</span>
                  <span className="font-medium">
                    {pessoa.compartilhada ? percentual(pessoa.fracaoDaCota) : "—"}
                  </span>
                </span>
                <Barra
                  className="mt-1"
                  fracao={
                    pessoa.compartilhada
                      ? (pessoa.fracaoDaCota ??
                        (maiorDoCiclo > 0 ? pessoa.ciclo.usd / maiorDoCiclo : 0))
                      : 0
                  }
                  titulo={
                    pessoa.compartilhada
                      ? `${usd(pessoa.ciclo.usd)} nesta semana`
                      : "Fora da cota compartilhada"
                  }
                />
              </td>
              <td className="text-right text-muted tabular-nums">
                {pessoa.compartilhada ? percentual(pessoa.parteDoCiclo) : "—"}
              </td>
              <td className="text-right font-medium tabular-nums">
                {usd(pessoa.periodo.usd)}
              </td>
              <td className="text-right text-muted tabular-nums">
                {formatarNumero(pessoa.periodo.chamadas)}
              </td>
              <td className="text-right text-muted tabular-nums">
                {tokens(pessoa.periodo)}
              </td>
            </tr>
          ))}
        </Tabela>

        {p.foraDoCusto.semTarifa > 0 || p.foraDoCusto.foraDaConta > 0 ? (
          <Meta className="block">
            Ficaram fora do custo equivalente:{" "}
            {p.foraDoCusto.semTarifa > 0
              ? `${formatarNumero(p.foraDoCusto.semTarifa)} chamadas de modelo Claude sem tarifa cadastrada`
              : null}
            {p.foraDoCusto.semTarifa > 0 && p.foraDoCusto.foraDaConta > 0 ? " e " : null}
            {p.foraDoCusto.foraDaConta > 0
              ? `${formatarNumero(p.foraDoCusto.foraDaConta)} de modelos de outra fatura (OpenRouter)`
              : null}
            . Os tokens delas aparecem na coluna ao lado.
          </Meta>
        ) : null}
      </section>

      {/* Dentro de cada pessoa, qual agente. Fechado por padrão: nove pessoas
          com cinco agentes cada, abertos, seriam uma parede. */}
      <section className="space-y-3">
        <TituloDeBloco
          icone={<Layers size={15} aria-hidden />}
          descricao="Abra uma pessoa para ver qual dos agentes dela gasta mais."
        >
          Por agente
        </TituloDeBloco>
        <div className="space-y-2">
          {p.pessoas
            .filter((x) => x.agentes.length > 0)
            .map((pessoa) => (
              <Recolhivel
                key={pessoa.conteiner}
                titulo={pessoa.nome}
                estado={
                  <Badge tone="accent">{usd(pessoa.ciclo.usd)} esta semana</Badge>
                }
                resumo={`${pessoa.agentes.length} agente${pessoa.agentes.length === 1 ? "" : "s"}`}
              >
                <Tabela
                  cabecalho={
                    <>
                      <th scope="col">Agente</th>
                      <th scope="col" className="text-right">
                        Esta semana
                      </th>
                      <th scope="col" className="text-right">
                        No período
                      </th>
                      <th scope="col" className="text-right">
                        Chamadas
                      </th>
                      <th scope="col" className="text-right">
                        Tokens
                      </th>
                    </>
                  }
                >
                  {pessoa.agentes.map((a) => (
                    <tr key={a.agente}>
                      <td className="font-mono text-xs">{a.agente}</td>
                      <td className="text-right tabular-nums">{usd(a.ciclo.usd)}</td>
                      <td className="text-right font-medium tabular-nums">
                        {usd(a.periodo.usd)}
                      </td>
                      <td className="text-right text-muted tabular-nums">
                        {formatarNumero(a.periodo.chamadas)}
                      </td>
                      <td className="text-right text-muted tabular-nums">{tokens(a.periodo)}</td>
                    </tr>
                  ))}
                </Tabela>
              </Recolhivel>
            ))}
        </div>
      </section>

      <Card className="space-y-3 p-4">
        <TituloDeBloco
          icone={<Cpu size={15} aria-hidden />}
          descricao={`Todos os OpenClaws juntos, dia a dia — ${intervalo.rotulo}.`}
        >
          Consumo por dia
        </TituloDeBloco>
        <GraficoDiario
          pontos={p.serieDiaria}
          rotulos={{ custo: "Custo equivalente", execucoes: "Chamadas", unidade: "chamada(s)" }}
        />
      </Card>

      <section className="space-y-3">
        <TituloDeBloco
          icone={<History size={15} aria-hidden />}
          descricao="Cada linha é uma semana da cota (de reset a reset), só da conta compartilhada. As horas bloqueadas são o tempo em que a Anthropic recusou as chamadas. Semana que travou pode aparecer um pouco abaixo ou acima de 100%: a cota é uma média estimada, e o limite real varia com o tipo de uso."
        >
          Semana a semana
        </TituloDeBloco>
        <Tabela
          cabecalho={
            <>
              <th scope="col">Semana (começou em)</th>
              <th scope="col" className="text-right">
                Consumo
              </th>
              <th scope="col" className="text-right">
                % da cota
              </th>
              <th scope="col" className="text-right">
                Bloqueada
              </th>
              <th scope="col">Quem gastou</th>
            </>
          }
        >
          {p.historico.map((c) => (
            <tr key={c.inicio.toISOString()}>
              <td className="whitespace-nowrap">
                {quando(c.inicio)}
                {c.atual ? <Badge className="ml-2">em curso</Badge> : null}
              </td>
              <td className="text-right font-medium tabular-nums">{usd(c.totais.usd)}</td>
              <td className="text-right text-muted tabular-nums">{percentual(c.fracaoDaCota)}</td>
              <td className="text-right whitespace-nowrap">
                {c.horasBloqueadas > 0 ? (
                  <Badge tone="danger">{duracaoEmHoras(c.horasBloqueadas)}</Badge>
                ) : (
                  <Meta>—</Meta>
                )}
              </td>
              <td className="min-w-0 text-xs text-muted">
                {c.porPessoa.length === 0
                  ? "—"
                  : c.porPessoa
                      .map(
                        (x) =>
                          `${x.nome}${x.compartilhada ? "" : " (conta própria)"} ${usd(x.usd)}`,
                      )
                      .join(" · ")}
              </td>
            </tr>
          ))}
        </Tabela>
      </section>

      <section className="space-y-3">
        <TituloDeBloco
          icone={<OctagonX size={15} aria-hidden />}
          descricao="Períodos em que a Anthropic recusou as chamadas da conta por cota. O OpenClaw não avisa ninguém: o agente tenta de novo a cada heartbeat e a conversa fica muda."
        >
          Bloqueios por cota
        </TituloDeBloco>

        {p.bloqueios.length === 0 ? (
          <Card className="p-4 text-sm text-muted">
            Nenhum bloqueio por cota no histórico coletado.
          </Card>
        ) : (
          <Tabela
            cabecalho={
              <>
                <th scope="col">Começou</th>
                <th scope="col">Voltou</th>
                <th scope="col" className="text-right">
                  Duração
                </th>
                <th scope="col">Atingiu</th>
                <th scope="col" className="text-right">
                  Chamadas recusadas
                </th>
                <th scope="col" className="text-right">
                  Gasto até travar
                </th>
              </>
            }
          >
            {p.bloqueios.map((b) => {
              const amostra = amostraDoBloqueio(b.inicio);
              return (
                <tr key={b.inicio.toISOString()}>
                  <td className="whitespace-nowrap">{quando(b.inicio)}</td>
                  <td className="whitespace-nowrap">
                    {b.emCurso ? <Badge tone="danger">em curso</Badge> : quando(b.fim)}
                  </td>
                  <td className="text-right font-medium tabular-nums">{duracaoEmHoras(b.horas)}</td>
                  <td className="min-w-0 text-xs">{b.conteineres.map(nomeDe).join(", ")}</td>
                  <td className="text-right text-muted tabular-nums">{formatarNumero(b.recusas)}</td>
                  <td className="text-right tabular-nums">
                    {amostra ? (
                      <span
                        title={
                          amostra.descartada
                            ? "Ficou de fora da estimativa da cota: parece uma semana com dados incompletos."
                            : "Entrou na média que estima a cota."
                        }
                      >
                        {usd(amostra.usd)}
                        {amostra.descartada ? <Meta className="ml-1">(fora da média)</Meta> : null}
                      </span>
                    ) : (
                      <Meta>—</Meta>
                    )}
                  </td>
                </tr>
              );
            })}
          </Tabela>
        )}

        <Meta className="block">
          A cota estimada é a média do <strong>gasto até travar</strong> nas semanas em
          que a conta bloqueou, sem as que parecem incompletas. É a melhor medida
          possível: a Anthropic não publica o limite, e o token dos OpenClaws não
          deixa consultá-lo. Cada novo bloqueio refina o número.
        </Meta>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3 p-4">
          <TituloDeBloco
            icone={<Cpu size={15} aria-hidden />}
            descricao={`Qual modelo gasta mais — ${intervalo.rotulo}.`}
          >
            Por modelo
          </TituloDeBloco>
          <Tabela
            cabecalho={
              <>
                <th scope="col">Modelo</th>
                <th scope="col" className="text-right">
                  Custo equiv.
                </th>
                <th scope="col" className="text-right">
                  Chamadas
                </th>
              </>
            }
          >
            {p.porModelo.map((m) => (
              <tr key={m.modelo}>
                <td className="min-w-0 font-mono text-xs">{m.modelo}</td>
                <td className="text-right font-medium tabular-nums">
                  {m.totais.chamadasSemTarifa + m.totais.chamadasForaDaConta > 0 ? (
                    <Meta>—</Meta>
                  ) : (
                    usd(m.totais.usd)
                  )}
                </td>
                <td className="text-right text-muted tabular-nums">
                  {formatarNumero(m.totais.chamadas)}
                </td>
              </tr>
            ))}
          </Tabela>
        </Card>

        <Card className="space-y-3 p-4">
          <TituloDeBloco
            icone={<CalendarClock size={15} aria-hidden />}
            descricao={`De onde vem o gasto — ${intervalo.rotulo}. "main" é a conversa principal do agente (inclui o heartbeat); o resto são painéis, rotinas agendadas e subagentes.`}
          >
            Por tipo de sessão
          </TituloDeBloco>
          <Tabela
            cabecalho={
              <>
                <th scope="col">Tipo</th>
                <th scope="col" className="text-right">
                  Custo equiv.
                </th>
                <th scope="col" className="text-right">
                  Chamadas
                </th>
              </>
            }
          >
            {p.porTipo.map((t) => (
              <tr key={t.tipo}>
                <td className="min-w-0 font-mono text-xs">{t.tipo}</td>
                <td className="text-right font-medium tabular-nums">{usd(t.totais.usd)}</td>
                <td className="text-right text-muted tabular-nums">
                  {formatarNumero(t.totais.chamadas)}
                </td>
              </tr>
            ))}
          </Tabela>
        </Card>
      </div>

      {p.cota.detalhe.length > 0 ? null : (
        <Aviso tone="neutral">
          Ainda não houve bloqueio com dados suficientes para medir a cota.
        </Aviso>
      )}

      {configuracao}

      {config.ultimaColeta && config.ultimaColetaEm ? (
        <Meta className="block">
          Última coleta: {quando(config.ultimaColetaEm)} — {config.ultimaColeta}.
        </Meta>
      ) : null}
    </div>
  );
}
