import Link from "next/link";
import { CheckCircle2, ExternalLink, Puzzle } from "lucide-react";
import { db } from "@/lib/db";
import { exigirSessao, podeEditar } from "@/server/auth-guard";
import {
  IntegrationProvider,
  SituacaoDaLacuna,
  TipoDeLacuna,
} from "@/generated/prisma/enums";
import { chatwootConfigSchema } from "@/server/integrations/chatwoot/config";
import { intervaloDoPeriodo, normalizarPeriodo } from "@/server/consumo/periodo";
import {
  agentesParaFiltro,
  lerLacunas,
  normalizarTipo,
} from "@/server/lacunas/consulta";
import {
  O_QUE_FORNECER,
  ROTULO_DA_SITUACAO,
  ROTULO_DO_TIPO,
} from "@/server/lacunas/regras";
import { ReabrirLacuna, ResolverLacuna } from "@/components/acoes-da-lacuna";
import { Filtros, type Campo } from "@/components/filtros";
import { Badge, EmptyState, PageHeader, Stat } from "@/components/ui";
import { cn, formatarData } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Busca = {
  aba?: string;
  periodo?: string;
  agente?: string;
  tipo?: string;
  quantidade?: string;
};

const QUANTIDADES = ["50", "100", "200"] as const;

const TOM_DO_TIPO: Record<TipoDeLacuna, "warning" | "accent" | "neutral"> = {
  [TipoDeLacuna.FALTA_INSTRUCAO]: "warning",
  [TipoDeLacuna.FALTA_FERRAMENTA]: "accent",
  [TipoDeLacuna.NAO_ENTENDI]: "neutral",
};

/**
 * Lacunas dos agentes: o que faltou para cada um resolver sozinho.
 *
 * Cada linha nasce quando um agente passa o atendimento a uma pessoa por não
 * conseguir seguir — falta de instrução, de ferramenta ou de entendimento — e
 * diz o que faltou. É a lista de trabalho de quem melhora os agentes: fornece o
 * que falta, RESOLVE a linha e escreve o que fez. Quem só lê vê as duas abas;
 * resolver e reabrir são de Administrador.
 *
 * Duas abas, na URL (`?aba=historico`) e renderizadas no servidor: **Abertas** é
 * a fila; **Histórico** guarda as resolvidas, com as duas datas, quem resolveu e
 * o comentário. Não existe mais exclusão (pedido do Diego, 12/11/2026): o que foi
 * tratado continua consultável.
 *
 * Sem período por padrão: a lista é uma fila de pendências, e recortar por data
 * esconderia a de ontem que ninguém tratou.
 */
export default async function LacunasPage({
  searchParams,
}: {
  searchParams: Promise<Busca>;
}) {
  const busca = await searchParams;
  const sessao = await exigirSessao();
  const editavel = podeEditar(sessao.user.role);

  const noHistorico = busca.aba === "historico";
  const situacao = noHistorico ? SituacaoDaLacuna.RESOLVIDA : SituacaoDaLacuna.ABERTA;

  const intervalo = intervaloDoPeriodo(
    busca.periodo ? normalizarPeriodo(busca.periodo) : "tudo",
  );
  const tipo = normalizarTipo(busca.tipo);
  const quantidade = (QUANTIDADES as readonly string[]).includes(
    busca.quantidade ?? "",
  )
    ? Number(busca.quantidade)
    : 50;

  const [resumo, agentes, integracao] = await Promise.all([
    lerLacunas({ intervalo, agentId: busca.agente ?? null, tipo, situacao }, quantidade),
    agentesParaFiltro(),
    db.integration.findUnique({
      where: { provider: IntegrationProvider.CHATWOOT },
    }),
  ]);

  const config = chatwootConfigSchema.safeParse(integracao?.config ?? {});
  const linkDaConversa = (id: number) =>
    config.success
      ? `${config.data.baseUrl}/app/accounts/${config.data.accountId}/conversations/${id}`
      : null;

  /** O endereço de cada aba mantém os filtros: trocar de aba não zera o recorte. */
  function hrefDaAba(historico: boolean) {
    const params = new URLSearchParams();
    for (const [chave, valor] of Object.entries(busca)) {
      if (chave !== "aba" && valor) params.set(chave, valor);
    }
    if (historico) params.set("aba", "historico");
    const texto = params.toString();
    return texto ? `/lacunas?${texto}` : "/lacunas";
  }

  const abas = [
    {
      historico: false,
      rotulo: ROTULO_DA_SITUACAO[SituacaoDaLacuna.ABERTA],
      contador: resumo.porSituacao[SituacaoDaLacuna.ABERTA],
    },
    {
      historico: true,
      rotulo: ROTULO_DA_SITUACAO[SituacaoDaLacuna.RESOLVIDA],
      contador: resumo.porSituacao[SituacaoDaLacuna.RESOLVIDA],
    },
  ];

  const campos: Campo[] = [
    {
      tipo: "select",
      chave: "periodo",
      rotulo: "Aberta no período",
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
        ...agentes.map((a) => ({
          valor: a.id,
          rotulo: a.arquivado ? `${a.nome} (arquivado)` : a.nome,
        })),
      ],
    },
    {
      tipo: "segmento",
      chave: "tipo",
      rotulo: "O que faltou",
      opcoes: [
        { valor: "", rotulo: "Tudo" },
        ...Object.values(TipoDeLacuna).map((t) => ({
          valor: t,
          rotulo: ROTULO_DO_TIPO[t],
        })),
      ],
    },
    {
      tipo: "select",
      chave: "quantidade",
      rotulo: "Mostrar",
      opcoes: QUANTIDADES.map((q) => ({
        valor: q,
        rotulo: noHistorico ? `${q} últimas resolvidas` : `${q} últimas`,
      })),
    },
  ];

  const filtrado = Boolean(busca.periodo || busca.agente || busca.tipo);
  const totalDosTipos = Object.values(resumo.porTipo).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        titulo="Lacunas dos agentes"
        descricao="Cada vez que um agente passou o atendimento a uma pessoa por não conseguir resolver sozinho — por falta de instrução, de ferramenta ou por não ter entendido o pedido. É a lista do que fornecer para os agentes melhorarem. Ao tratar, resolva a linha e escreva o que foi feito: ela vai para o Histórico, com a data de abertura e a de resolução."
      />

      <nav
        aria-label="Situação das lacunas"
        className="flex flex-wrap gap-x-1 border-b border-line"
      >
        {abas.map((a) => {
          const ativa = a.historico === noHistorico;
          return (
            <Link
              key={a.rotulo}
              href={hrefDaAba(a.historico)}
              aria-current={ativa ? "page" : undefined}
              className={cn(
                "-mb-px flex shrink-0 items-center gap-2 rounded-t-lg border-b-2 px-3.5 py-3 text-sm whitespace-nowrap transition-colors",
                "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                ativa
                  ? "border-accent font-medium text-foreground"
                  : "border-transparent text-muted hover:bg-foreground/[0.03] hover:text-foreground",
              )}
            >
              {a.rotulo}
              {/* Zero não informa nada — só polui a tira. */}
              {a.contador ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
                    ativa
                      ? "bg-accent/12 text-accent"
                      : "bg-foreground/[0.06] text-muted",
                  )}
                >
                  {a.contador}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          rotulo="No filtro"
          valor={resumo.total}
          detalhe={
            tipo
              ? ROTULO_DO_TIPO[tipo]
              : noHistorico
                ? "resolvidas, todas as causas"
                : "abertas, todas as causas"
          }
          destaque
        />
        {Object.values(TipoDeLacuna).map((t) => (
          <Stat
            key={t}
            rotulo={ROTULO_DO_TIPO[t]}
            valor={resumo.porTipo[t]}
            detalhe={O_QUE_FORNECER[t]}
          />
        ))}
      </div>

      <Filtros campos={campos} valores={busca} />

      {resumo.itens.length === 0 ? (
        <EmptyState
          icone={<Puzzle size={18} aria-hidden />}
          titulo={
            filtrado
              ? "Nenhuma lacuna com esses filtros"
              : noHistorico
                ? "Nenhuma lacuna resolvida ainda"
                : "Nenhuma lacuna aberta"
          }
          descricao={
            filtrado
              ? totalDosTipos > 0
                ? "Tire um filtro: há lacunas fora deste recorte."
                : "Tire um filtro ou amplie o período."
              : noHistorico
                ? "Quando alguém resolver uma lacuna, ela aparece aqui com o que foi feito e as datas."
                : "Quando um agente passar uma conversa a uma pessoa por não conseguir resolver sozinho, o que faltou aparece aqui."
          }
        />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            {resumo.itens.length < resumo.total
              ? `Mostrando as ${resumo.itens.length} ${noHistorico ? "resolvidas mais recentemente" : "mais recentes"} de ${resumo.total}.`
              : `${resumo.total} ${resumo.total === 1 ? "lacuna" : "lacunas"}.`}
          </p>

          <ul className="space-y-2">
            {resumo.itens.map((l) => {
              const link = linkDaConversa(l.chatwootConversationId);
              return (
                <li
                  key={l.id}
                  className="rounded-xl border border-line bg-surface p-4 shadow-[var(--shadow-card)]"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Badge tone={TOM_DO_TIPO[l.tipo]}>{ROTULO_DO_TIPO[l.tipo]}</Badge>
                    <Link
                      href={`/agentes/${l.agente.id}`}
                      className="text-sm font-medium hover:text-accent"
                    >
                      {l.agente.nome}
                    </Link>
                    <span className="text-xs text-muted tabular-nums">
                      Aberta em {formatarData(l.criadaEm)}
                    </span>
                    {link ? (
                      <a
                        href={link}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted hover:text-accent"
                      >
                        Conversa #{l.chatwootConversationId}
                        <ExternalLink size={11} aria-hidden />
                      </a>
                    ) : (
                      <span className="text-xs text-muted">
                        Conversa #{l.chatwootConversationId}
                      </span>
                    )}
                    {noHistorico && editavel ? (
                      <div className="ml-auto">
                        <ReabrirLacuna id={l.id} />
                      </div>
                    ) : null}
                  </div>

                  <p className="mt-3 text-sm leading-relaxed font-medium">
                    {l.oQueFaltou || "O agente não disse o que faltou."}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    Motivo da passagem: {l.motivo}
                  </p>

                  {noHistorico ? (
                    <div className="mt-3 rounded-lg border border-line bg-surface-2 p-3">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium">
                        <CheckCircle2
                          size={13}
                          className="text-success"
                          aria-hidden
                        />
                        Resolvida
                        {l.resolvidaEm ? (
                          <span className="font-normal text-muted tabular-nums">
                            em {formatarData(l.resolvidaEm)}
                          </span>
                        ) : null}
                        {l.resolvidaPor ? (
                          <span className="font-normal text-muted">
                            por {l.resolvidaPor}
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-line">
                        {l.resolucao || "Sem comentário registrado."}
                      </p>
                    </div>
                  ) : editavel ? (
                    <div className="mt-3">
                      <ResolverLacuna id={l.id} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {resumo.porAgente.length > 1 ? (
            <p className="text-xs leading-relaxed text-muted">
              Quem mais passa conversa:{" "}
              {resumo.porAgente
                .map((a) => `${a.nome} (${a.total})`)
                .join(" · ")}
              .
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
