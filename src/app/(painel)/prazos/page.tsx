import { notFound } from "next/navigation";
import {
  Bot,
  CalendarRange,
  ExternalLink,
  MessagesSquare,
  Timer,
  UserCheck,
} from "lucide-react";
import { db } from "@/lib/db";
import { exigirSessao } from "@/server/auth-guard";
import { alcancaPapel } from "@/lib/papeis";
import {
  IntegrationProvider,
  PrazoStatus,
  PrazoTipo,
  UserRole,
} from "@/generated/prisma/enums";
import { chatwootConfigSchema } from "@/server/integrations/chatwoot/config";
import {
  baseDaTaxa,
  contarPrazosPerdidos,
  ROTULO_DA_ACAO,
  type LinhaDePrazo,
  type Perda,
  type Placar,
} from "@/server/prazos/contagem";
// O recorte de período é o MESMO de /consumo, e de propósito: dois cálculos de
// "últimos 30 dias" no painel divergiriam no dia em que alguém corrigisse um só.
import {
  intervaloDoPeriodo,
  normalizarPeriodo,
  PERIODOS,
  ROTULO_DO_PERIODO,
} from "@/server/consumo/periodo";
import { Filtros, type Campo } from "@/components/filtros";
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

/** Acima disto a tela pede um recorte menor em vez de mostrar meia conta. */
const TETO_DE_LINHAS = 5000;

/** Quantas linhas do bloco "fora da conta" cabem sem virar despejo. */
const FORA_DA_CONTA_NA_TELA = 50;

/**
 * Quantas conversas cada lista mostra: as perdas de cada pessoa e as que
 * voltaram para o agente (pedido do usuário, 18/09/2026). O filtro de período
 * alcança o resto.
 */
const ULTIMAS_POR_LISTA = 10;

type Busca = { periodo?: string; de?: string; ate?: string };

/** `0.214` → `21%`. Sem base, "—" em vez de um zero que pareceria elogio. */
const percentual = (taxa: number | null) =>
  taxa == null ? "—" : `${Math.round(taxa * 100)}%`;

/**
 * Prazos: o que aconteceu com as conversas entregues a cada pessoa.
 *
 * ⚠ **Só Proprietário** (decisão do usuário, 16/09/2026). É uma medida por
 * pessoa, e o painel é aberto à equipe inteira — inclusive a quem está sendo
 * medido. Quem decide o que fazer com o número é quem responde pela equipe, e a
 * descrição do papel em `lib/papeis.ts` diz isso em letras claras.
 *
 * O dado não é novo: cada vencimento já grava uma linha em `PrazoDeConversa`
 * desde 14/09/2026. O que faltava era somar — e somar AQUI, nunca como nota
 * privada na conversa, que fica dentro do atendimento e teria de ser aberta uma
 * a uma para virar conta.
 *
 * ⚠ **A tela lidera pela TAXA, não pela contagem** (pedido do usuário no mesmo
 * dia). Contagem crua pune quem atende mais: três perdas em trinta entregas
 * apareciam piores que duas em quatro. O denominador, e o que fica de fora
 * dele, estão em `prazos/contagem.ts`.
 */
export default async function PrazosPage({
  searchParams,
}: {
  searchParams: Promise<Busca>;
}) {
  const busca = await searchParams;
  const sessao = await exigirSessao();

  // ⚠ 404, e não o erro de "sem permissão" das outras telas restritas. Esta
  // tela é escondida da barra lateral de propósito; recusar com uma mensagem
  // que confirma a existência dela contaria a quem está sendo medido que a
  // medida existe. A régua é a mesma de sempre — quem guarda é isto aqui, e
  // não o item sumido do menu.
  if (!alcancaPapel(sessao.user.role, UserRole.OWNER)) notFound();

  const periodo = normalizarPeriodo(busca.periodo);
  const intervalo = intervaloDoPeriodo(periodo, { de: busca.de, ate: busca.ate });

  // O corte é por `finalizadoEm`: o que interessa é quando o prazo VENCEU, não
  // quando o agente o registrou. Um prazo de 1 h registrado às 23h30 vence no
  // dia seguinte, e contá-lo no dia anterior deslocaria a apuração.
  const quando =
    intervalo.inicio || intervalo.fim
      ? {
          ...(intervalo.inicio ? { gte: intervalo.inicio } : {}),
          ...(intervalo.fim ? { lt: intervalo.fim } : {}),
        }
      : undefined;

  const [linhas, integracao, agentes] = await Promise.all([
    db.prazoDeConversa.findMany({
      where: {
        tipo: PrazoTipo.EQUIPE,
        // PENDENTE e EXECUTANDO ficam de fora: ainda não venceram, ou estão
        // sendo decididos neste minuto.
        status: {
          in: [
            PrazoStatus.EXECUTADO,
            PrazoStatus.FALHOU,
            PrazoStatus.CANCELADO,
            PrazoStatus.DESCARTADO,
          ],
        },
        ...(quando ? { finalizadoEm: quando } : {}),
      },
      orderBy: { finalizadoEm: "asc" },
      take: TETO_DE_LINHAS + 1,
      select: {
        donoId: true,
        donoNome: true,
        agentId: true,
        status: true,
        acao: true,
        resultado: true,
        chatwootConversationId: true,
        criadoEm: true,
        finalizadoEm: true,
      },
    }),
    db.integration.findUnique({
      where: { provider: IntegrationProvider.CHATWOOT },
    }),
    db.agent.findMany({ select: { id: true, name: true } }),
  ]);

  const config = chatwootConfigSchema.safeParse(integracao?.config ?? {});
  const linkChatwoot = (id: number) =>
    config.success
      ? `${config.data.baseUrl}/app/accounts/${config.data.accountId}/conversations/${id}`
      : null;

  /** A conversa, clicável quando o Chatwoot está configurado. Uma forma só na tela inteira. */
  const conversaNoChatwoot = (id: number) => {
    const url = linkChatwoot(id);
    return url ? (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title="Abrir no Chatwoot"
        className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
      >
        conversa {id}
        <ExternalLink size={11} aria-hidden />
      </a>
    ) : (
      <Meta>conversa {id}</Meta>
    );
  };

  const nomeDoAgente = new Map(agentes.map((a) => [a.id, a.name]));

  const cabecalho = (
    <PageHeader
      titulo="Prazos"
      descricao={
        <>
          O que aconteceu com as conversas que o robô entregou a cada pessoa com
          um prazo de resposta correndo. <strong>Deixou vencer</strong> e{" "}
          <strong>respondeu a tempo</strong> são os dois lados da mesma
          conferência: no vencimento o sistema lê o Chatwoot ao vivo e vê se
          alguém da equipe escreveu na conversa.
        </>
      }
      acoes={<Badge tone="accent">só Proprietário</Badge>}
    />
  );

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
  ];
  const filtros = <Filtros campos={campos} valores={busca} />;

  if (linhas.length > TETO_DE_LINHAS) {
    return (
      <div className="space-y-6">
        {cabecalho}
        {filtros}
        <Aviso tone="warning">
          O período escolhido tem mais de{" "}
          <strong>{formatarNumero(TETO_DE_LINHAS)} prazos</strong>, acima do que
          esta tela soma de uma vez. Escolha um intervalo menor — melhor pedir um
          recorte do que mostrar um total incompleto que parece certo.
        </Aviso>
      </div>
    );
  }

  const contagem = contarPrazosPerdidos(linhas as LinhaDePrazo[]);
  const { pessoas, totais, porAgente, destinos, conversas, perdas, foraDaConta } =
    contagem;

  /** Na ordem da tabela: quem mais perdeu primeiro. */
  const quemPerdeu = pessoas.filter((p) => p.perdas.length > 0);
  const voltasAoAgente = perdas.filter((p) => p.acao === "devolvida");

  const agenteDa = (perda: Perda) =>
    nomeDoAgente.get(perda.agentId) ?? <Meta>agente removido</Meta>;

  const oQueHouve = (perda: Perda) =>
    perda.destino ? (
      <Badge>para {perda.destino}</Badge>
    ) : perda.acao === "devolvida" ? (
      <Badge>para o agente</Badge>
    ) : perda.acao ? (
      <Badge>{ROTULO_DA_ACAO[perda.acao]}</Badge>
    ) : (
      <Meta>—</Meta>
    );

  /** O detalhe que explica de onde saiu o "recebeu" daquela linha. */
  const detalheDoPlacar = (p: Placar) =>
    [
      `${p.perdeu} deixou vencer`,
      `${p.respondeu} respondeu a tempo`,
      p.resolvida ? `${p.resolvida} conversa resolvida antes` : null,
      p.saiu ? `${p.saiu} saiu das mãos dela antes` : null,
      p.semConclusao ? `${p.semConclusao} sem conclusão` : null,
    ]
      .filter(Boolean)
      .join(" · ");

  /** Barra + percentual, com a fração no título: 100% de 1 não é 100% de 40. */
  const taxaNaLinha = (p: Placar) => (
    <span className="flex items-center gap-2">
      <Barra
        fracao={p.taxa ?? 0}
        titulo={
          p.taxa == null
            ? "Nenhum prazo terminou com ou sem resposta"
            : `${p.perdeu} de ${baseDaTaxa(p)}`
        }
      />
      <span className="w-9 shrink-0 text-right text-xs font-medium tabular-nums">
        {percentual(p.taxa)}
      </span>
    </span>
  );

  return (
    <div className="space-y-6">
      {cabecalho}
      {filtros}

      {pessoas.length === 0 ? (
        <EmptyState
          icone={<CalendarRange size={18} aria-hidden />}
          titulo={`Nenhum prazo da equipe terminou — ${intervalo.rotulo}`}
          descricao="Nenhum agente registrou prazo de resposta da equipe no período, ou os que registrou ainda estão correndo. Quem registra é o agente com a integração Prazos ligada, logo depois de passar a conversa para uma pessoa."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              rotulo="Taxa de perda"
              valor={percentual(totais.taxa)}
              destaque
              detalhe={
                totais.taxa == null
                  ? "Nenhum prazo terminou com ou sem resposta no período."
                  : `${formatarNumero(totais.perdeu)} de ${formatarNumero(
                      baseDaTaxa(totais),
                    )} prazos que terminaram com ou sem resposta da equipe.`
              }
            />
            <Stat
              rotulo="Prazos perdidos"
              valor={formatarNumero(totais.perdeu)}
              detalhe={`De ${formatarNumero(
                totais.recebeu,
              )} conversas entregues com o relógio correndo — ${intervalo.rotulo}.`}
            />
            <Stat
              rotulo="Conversas afetadas"
              valor={formatarNumero(conversas.afetadas)}
              detalhe={
                conversas.maisDeUmaVez > 0
                  ? `${formatarNumero(
                      conversas.maisDeUmaVez,
                    )} perderam prazo mais de uma vez — o cliente esperou duas rodadas.`
                  : "Nenhuma perdeu prazo duas vezes."
              }
            />
            <Stat
              rotulo="Voltou para o agente"
              valor={formatarNumero(contagem.devolvidasAoAgente)}
              detalhe="Nessas, o robô retomou o atendimento e seguiu sozinho em vez de passar a outra pessoa."
            />
          </div>

          <Tabela
            cabecalho={
              <>
                <th scope="col">Pessoa</th>
                <th scope="col" className="w-36">
                  Taxa de perda
                </th>
                <th scope="col" className="text-right">
                  Deixou vencer
                </th>
                <th scope="col" className="text-right">
                  Respondeu a tempo
                </th>
                <th scope="col" className="text-right">
                  Recebeu
                </th>
                <th scope="col">Última perda</th>
              </>
            }
          >
            {pessoas.map((pessoa) => {
              const comoPerdeu = [
                pessoa.reatribuidas
                  ? `${pessoa.reatribuidas} ${ROTULO_DA_ACAO.reatribuida}`
                  : null,
                pessoa.devolvidas
                  ? `${pessoa.devolvidas} ${ROTULO_DA_ACAO.devolvida}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ");

              return (
                <tr key={pessoa.chave}>
                  <td className="min-w-0 font-medium">{pessoa.nome}</td>
                  <td>{taxaNaLinha(pessoa)}</td>
                  <td className="text-right">
                    <span className="font-medium tabular-nums">
                      {formatarNumero(pessoa.perdeu)}
                    </span>
                    {comoPerdeu ? (
                      <Meta className="block text-[11px]">{comoPerdeu}</Meta>
                    ) : null}
                  </td>
                  <td className="text-right text-muted tabular-nums">
                    {formatarNumero(pessoa.respondeu)}
                  </td>
                  <td
                    className="text-right text-muted tabular-nums"
                    title={detalheDoPlacar(pessoa)}
                  >
                    {formatarNumero(pessoa.recebeu)}
                  </td>
                  <td className="whitespace-nowrap">
                    {pessoa.ultimaPerda ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Meta>{formatarData(pessoa.ultimaPerda.quando)}</Meta>
                        {conversaNoChatwoot(pessoa.ultimaPerda.conversa)}
                        {pessoa.ultimaPerda.destino ? (
                          <Badge>para {pessoa.ultimaPerda.destino}</Badge>
                        ) : pessoa.ultimaPerda.acao === "devolvida" ? (
                          <Badge>para o agente</Badge>
                        ) : null}
                      </span>
                    ) : (
                      <Meta>nunca deixou vencer no período</Meta>
                    )}
                  </td>
                </tr>
              );
            })}
          </Tabela>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Em QUE fluxo se perde. A mesma pessoa pode ir bem na reserva de
                sala e mal na venda: o agente é a única pista de contexto que o
                registro do prazo carrega. */}
            <Card className="space-y-3 p-4">
              <TituloDeBloco
                icone={<Bot size={15} aria-hidden />}
                descricao="Qual agente estava conduzindo quando o prazo foi registrado."
              >
                Onde a perda acontece
              </TituloDeBloco>

              <Tabela
                cabecalho={
                  <>
                    <th scope="col">Agente</th>
                    <th scope="col" className="w-28">
                      Taxa
                    </th>
                    <th scope="col" className="text-right">
                      Perdeu
                    </th>
                    <th scope="col" className="text-right">
                      Recebeu
                    </th>
                  </>
                }
              >
                {porAgente.map((agente) => (
                  <tr key={agente.agentId}>
                    <td className="min-w-0">
                      {nomeDoAgente.get(agente.agentId) ?? (
                        <Meta>agente removido</Meta>
                      )}
                    </td>
                    <td>{taxaNaLinha(agente)}</td>
                    <td className="text-right font-medium tabular-nums">
                      {formatarNumero(agente.perdeu)}
                    </td>
                    <td
                      className="text-right text-muted tabular-nums"
                      title={detalheDoPlacar(agente)}
                    >
                      {formatarNumero(agente.recebeu)}
                    </td>
                  </tr>
                ))}
              </Tabela>
            </Card>

            {/* Quem paga a conta da perda: a conversa cai no colo de outra
                pessoa, e essa carga não aparece em lugar nenhum do painel. */}
            <Card className="space-y-3 p-4">
              <TituloDeBloco
                icone={<UserCheck size={15} aria-hidden />}
                descricao="Para onde a conversa foi quando o prazo venceu — é trabalho que caiu no colo de alguém."
              >
                Quem assumiu depois
              </TituloDeBloco>

              {destinos.length === 0 && contagem.devolvidasAoAgente === 0 ? (
                <p className="text-sm text-muted">
                  Nenhuma conversa mudou de mãos por prazo vencido no período.
                </p>
              ) : (
                <Tabela
                  cabecalho={
                    <>
                      <th scope="col">Quem assumiu</th>
                      <th scope="col" className="text-right">
                        Conversas
                      </th>
                    </>
                  }
                >
                  {destinos.map((d) => (
                    <tr key={d.nome}>
                      <td>{d.nome}</td>
                      <td className="text-right font-medium tabular-nums">
                        {formatarNumero(d.vezes)}
                      </td>
                    </tr>
                  ))}
                  {contagem.devolvidasAoAgente > 0 ? (
                    <tr>
                      <td>
                        <span className="flex items-center gap-1.5">
                          <Bot size={13} aria-hidden className="text-muted" />
                          O próprio agente
                        </span>
                      </td>
                      <td className="text-right font-medium tabular-nums">
                        {formatarNumero(contagem.devolvidasAoAgente)}
                      </td>
                    </tr>
                  ) : null}
                </Tabela>
              )}
            </Card>
          </div>

          {/* A tabela por pessoa aponta só a ÚLTIMA perda. Aqui estão as
              últimas de cada uma, com o caminho até a conversa: é lá que se
              confere o que aconteceu antes de cobrar alguém pelo número. Uma
              linha por pessoa, que abre — dez linhas de cada, abertas, seriam
              uma parede. */}
          {quemPerdeu.length > 0 ? (
            <section className="space-y-3">
              <TituloDeBloco
                icone={<MessagesSquare size={15} aria-hidden />}
                descricao={`As ${ULTIMAS_POR_LISTA} mais recentes de cada pessoa. Abra a linha para ver as conversas; o link abre no Chatwoot.`}
              >
                Últimas perdas de cada pessoa
              </TituloDeBloco>

              <div className="space-y-2">
                {quemPerdeu.map((pessoa) => (
                  <Recolhivel
                    key={pessoa.chave}
                    titulo={pessoa.nome}
                    estado={
                      <Badge tone="accent">
                        {formatarNumero(pessoa.perdeu)}{" "}
                        {pessoa.perdeu === 1 ? "perda" : "perdas"}
                      </Badge>
                    }
                    resumo={
                      pessoa.ultimaPerda
                        ? `última em ${formatarData(pessoa.ultimaPerda.quando)}`
                        : null
                    }
                  >
                    <Tabela
                      cabecalho={
                        <>
                          <th scope="col">Quando</th>
                          <th scope="col">Conversa</th>
                          <th scope="col">Agente</th>
                          <th scope="col">O que houve</th>
                        </>
                      }
                    >
                      {pessoa.perdas.slice(0, ULTIMAS_POR_LISTA).map((perda, i) => (
                        <tr key={`${perda.conversa}-${perda.quando.getTime()}-${i}`}>
                          <td className="whitespace-nowrap">
                            <Meta>{formatarData(perda.quando)}</Meta>
                          </td>
                          <td className="whitespace-nowrap">
                            {conversaNoChatwoot(perda.conversa)}
                          </td>
                          <td className="text-xs">{agenteDa(perda)}</td>
                          <td>{oQueHouve(perda)}</td>
                        </tr>
                      ))}
                    </Tabela>

                    {pessoa.perdas.length > ULTIMAS_POR_LISTA ? (
                      <Meta className="block">
                        Mostrando as {ULTIMAS_POR_LISTA} mais recentes de{" "}
                        {formatarNumero(pessoa.perdas.length)}. Para chegar às
                        mais antigas, escolha um período menor.
                      </Meta>
                    ) : null}
                  </Recolhivel>
                ))}
              </div>
            </section>
          ) : null}

          {/* Nessas, ninguém respondeu a tempo e o agente de I.A. retomou o
              atendimento sozinho. É onde o robô vendeu ou deixou de vender no
              lugar de alguém — vale abrir e conferir. */}
          {voltasAoAgente.length > 0 ? (
            <Card className="space-y-3 p-4">
              <TituloDeBloco
                icone={<Bot size={15} aria-hidden />}
                descricao={`As ${ULTIMAS_POR_LISTA} mais recentes em que ninguém respondeu a tempo e a conversa voltou para o agente de I.A., que seguiu o atendimento sozinho.`}
              >
                Voltaram para o agente ({formatarNumero(voltasAoAgente.length)})
              </TituloDeBloco>

              <Tabela
                cabecalho={
                  <>
                    <th scope="col">Quando</th>
                    <th scope="col">Conversa</th>
                    <th scope="col">Estava com</th>
                    <th scope="col">Agente que retomou</th>
                  </>
                }
              >
                {voltasAoAgente.slice(0, ULTIMAS_POR_LISTA).map((perda, i) => (
                  <tr key={`${perda.conversa}-${perda.quando.getTime()}-${i}`}>
                    <td className="whitespace-nowrap">
                      <Meta>{formatarData(perda.quando)}</Meta>
                    </td>
                    <td className="whitespace-nowrap">
                      {conversaNoChatwoot(perda.conversa)}
                    </td>
                    <td className="text-xs">{perda.quem}</td>
                    <td className="text-xs">{agenteDa(perda)}</td>
                  </tr>
                ))}
              </Tabela>

              {voltasAoAgente.length > ULTIMAS_POR_LISTA ? (
                <Meta className="block">
                  Mostrando as {ULTIMAS_POR_LISTA} mais recentes de{" "}
                  {formatarNumero(voltasAoAgente.length)}.
                </Meta>
              ) : null}
            </Card>
          ) : null}
        </>
      )}

      {/* ⚠ Este bloco é o que impede a taxa de mentir por omissão: nem todo
          prazo vencido diz se a pessoa respondeu, e quem lê precisa ver o
          tamanho do que ficou fora antes de cobrar alguém pelo resto. */}
      {foraDaConta.length > 0 ? (
        <Card className="space-y-3 p-4">
          <TituloDeBloco
            icone={<Timer size={15} aria-hidden />}
            descricao="Prazos que venceram sem o vigia conseguir concluir — worker fora do ar, integração desligada, Chatwoot sem responder. Pelo registro não dá para saber se a pessoa tinha respondido, então não entram na taxa de ninguém."
          >
            Fora da conta ({formatarNumero(foraDaConta.length)})
          </TituloDeBloco>

          <Tabela
            cabecalho={
              <>
                <th scope="col">Quando</th>
                <th scope="col">Conversa</th>
                <th scope="col">Estava com</th>
                <th scope="col">Situação</th>
                <th scope="col">Motivo registrado</th>
              </>
            }
          >
            {foraDaConta.slice(0, FORA_DA_CONTA_NA_TELA).map((fora, i) => (
              <tr key={`${fora.conversa}-${fora.quando.getTime()}-${i}`}>
                <td className="whitespace-nowrap">
                  <Meta>{formatarData(fora.quando)}</Meta>
                </td>
                <td className="whitespace-nowrap">
                  {conversaNoChatwoot(fora.conversa)}
                </td>
                <td className="text-xs">{fora.quem ?? <Meta>—</Meta>}</td>
                <td>
                  <Badge>{fora.status.toLowerCase()}</Badge>
                </td>
                <td className="text-xs text-muted">{fora.motivo ?? "—"}</td>
              </tr>
            ))}
          </Tabela>

          {foraDaConta.length > FORA_DA_CONTA_NA_TELA ? (
            <Meta className="block">
              Mostrando os {FORA_DA_CONTA_NA_TELA} mais recentes de{" "}
              {formatarNumero(foraDaConta.length)}.
            </Meta>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
