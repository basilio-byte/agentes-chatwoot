import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarRange, Timer } from "lucide-react";
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
  contarPrazosPerdidos,
  ROTULO_DO_DESFECHO,
  type LinhaDePrazo,
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

type Busca = { periodo?: string; de?: string; ate?: string };

/**
 * Prazos: quantas vezes cada pessoa deixou um prazo da equipe vencer.
 *
 * ⚠ **Só Proprietário** (decisão do usuário, 16/09/2026). É uma contagem por
 * pessoa, e o painel é aberto à equipe inteira — inclusive a quem está sendo
 * contado. Quem decide o que fazer com o número é quem responde pela equipe, e
 * a descrição do papel em `lib/papeis.ts` diz isso em letras claras.
 *
 * O dado não é novo: cada vencimento já grava uma linha em `PrazoDeConversa`
 * desde 14/09/2026. O que faltava era somar — e somar AQUI, nunca como nota
 * privada na conversa, que fica dentro do atendimento e teria de ser aberta
 * uma a uma para virar conta.
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
  // que confirma a existência dela contaria a quem está sendo contado que a
  // contagem existe. A régua é a mesma de sempre — quem guarda é isto aqui, e
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

  const [linhas, integracao] = await Promise.all([
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
        status: true,
        acao: true,
        resultado: true,
        minutos: true,
        chatwootConversationId: true,
        criadoEm: true,
        finalizadoEm: true,
      },
    }),
    db.integration.findUnique({
      where: { provider: IntegrationProvider.CHATWOOT },
    }),
  ]);

  const config = chatwootConfigSchema.safeParse(integracao?.config ?? {});
  const linkChatwoot = (id: number) =>
    config.success
      ? `${config.data.baseUrl}/app/accounts/${config.data.accountId}/conversations/${id}`
      : null;

  const cabecalho = (
    <PageHeader
      titulo="Prazos"
      descricao={
        <>
          Quantas vezes cada pessoa deixou vencer um prazo de resposta da equipe
          — o tempo que o agente marca ao passar a conversa para alguém. Conta só
          o vencimento em que o sistema <strong>leu o Chatwoot ao vivo</strong> e
          confirmou que ninguém da equipe tinha escrito.
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

  const { pessoas, total, foraDaConta } = contarPrazosPerdidos(
    linhas as LinhaDePrazo[],
  );
  const maior = pessoas[0]?.total ?? 0;
  const devolvidas = pessoas.reduce((soma, p) => soma + p.devolvidas, 0);

  return (
    <div className="space-y-6">
      {cabecalho}
      {filtros}

      {pessoas.length === 0 ? (
        <EmptyState
          icone={<CalendarRange size={18} aria-hidden />}
          titulo={`Nenhum prazo da equipe venceu — ${intervalo.rotulo}`}
          descricao="Ou ninguém deixou vencer, ou nenhum agente registrou prazo no período. Quem registra é o agente com a integração Prazos ligada, logo depois de passar a conversa para uma pessoa."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat
              rotulo="Prazos perdidos"
              valor={formatarNumero(total)}
              destaque
              detalhe={`Com falta confirmada. Período: ${intervalo.rotulo}.`}
            />
            <Stat
              rotulo="Pessoas"
              valor={formatarNumero(pessoas.length)}
              detalhe="Quem aparece pelo menos uma vez no período."
            />
            <Stat
              rotulo={ROTULO_DO_DESFECHO.devolvida}
              valor={formatarNumero(devolvidas)}
              detalhe="Nessas, o agente retomou o atendimento e seguiu sozinho."
            />
          </div>

          <Tabela
            cabecalho={
              <>
                <th scope="col">Pessoa</th>
                <th scope="col" className="w-32">
                  Proporção
                </th>
                <th scope="col" className="text-right">
                  Perdeu
                </th>
                <th scope="col" className="text-right">
                  {ROTULO_DO_DESFECHO.reatribuida}
                </th>
                <th scope="col" className="text-right">
                  {ROTULO_DO_DESFECHO.devolvida}
                </th>
                <th scope="col">Última vez</th>
              </>
            }
          >
            {pessoas.map((pessoa) => {
              const url = pessoa.ultima
                ? linkChatwoot(pessoa.ultima.conversa)
                : null;
              return (
                <tr key={pessoa.chave}>
                  <td className="min-w-0 font-medium">{pessoa.nome}</td>
                  <td>
                    <Barra
                      fracao={maior > 0 ? pessoa.total / maior : 0}
                      titulo={`${pessoa.total} de ${total} no período`}
                    />
                  </td>
                  <td className="text-right font-medium tabular-nums">
                    {formatarNumero(pessoa.total)}
                  </td>
                  <td className="text-right text-muted tabular-nums">
                    {formatarNumero(pessoa.reatribuidas)}
                  </td>
                  <td className="text-right text-muted tabular-nums">
                    {formatarNumero(pessoa.devolvidas)}
                  </td>
                  <td className="whitespace-nowrap">
                    {pessoa.ultima ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Meta>{formatarData(pessoa.ultima.quando)}</Meta>
                        {url ? (
                          <Link
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            prefetch={false}
                            className="text-xs text-accent hover:underline"
                          >
                            conversa {pessoa.ultima.conversa}
                          </Link>
                        ) : (
                          <Meta>conversa {pessoa.ultima.conversa}</Meta>
                        )}
                        {pessoa.ultima.desfecho ? (
                          <Badge>
                            {ROTULO_DO_DESFECHO[
                              pessoa.ultima.desfecho
                            ].toLowerCase()}
                          </Badge>
                        ) : null}
                      </span>
                    ) : (
                      <Meta>—</Meta>
                    )}
                  </td>
                </tr>
              );
            })}
          </Tabela>
        </>
      )}

      {/* ⚠ Este bloco é o que impede o número acima de mentir por omissão: nem
          todo prazo vencido vira falta de alguém, e quem lê a tela precisa ver
          o tamanho do que ficou de fora antes de cobrar alguém pelo resto. */}
      {foraDaConta.length > 0 ? (
        <Card className="space-y-3 p-4">
          <TituloDeBloco
            icone={<Timer size={15} aria-hidden />}
            descricao="Prazos que venceram e não entraram na conta de ninguém. Cancelado quer dizer que alguém respondeu a tempo — é o sistema funcionando. Descartado e falhou são casos em que o vigia não concluiu, e pelo registro não dá para saber se houve falta."
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
            {foraDaConta.slice(0, FORA_DA_CONTA_NA_TELA).map((fora, i) => {
              const url = linkChatwoot(fora.conversa);
              return (
                <tr key={`${fora.conversa}-${fora.quando.getTime()}-${i}`}>
                  <td className="whitespace-nowrap">
                    <Meta>{formatarData(fora.quando)}</Meta>
                  </td>
                  <td className="whitespace-nowrap">
                    {url ? (
                      <Link
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        prefetch={false}
                        className="text-xs text-accent hover:underline"
                      >
                        conversa {fora.conversa}
                      </Link>
                    ) : (
                      <Meta>conversa {fora.conversa}</Meta>
                    )}
                  </td>
                  <td className="text-xs">{fora.quem ?? <Meta>—</Meta>}</td>
                  <td>
                    <Badge
                      tone={
                        fora.status === PrazoStatus.CANCELADO
                          ? "success"
                          : "neutral"
                      }
                    >
                      {fora.status.toLowerCase()}
                    </Badge>
                  </td>
                  <td className="text-xs text-muted">{fora.motivo ?? "—"}</td>
                </tr>
              );
            })}
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
