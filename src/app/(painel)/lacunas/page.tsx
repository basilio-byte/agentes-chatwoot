import Link from "next/link";
import { ExternalLink, Puzzle } from "lucide-react";
import { db } from "@/lib/db";
import { exigirSessao, podeEditar } from "@/server/auth-guard";
import { IntegrationProvider, TipoDeLacuna } from "@/generated/prisma/enums";
import { chatwootConfigSchema } from "@/server/integrations/chatwoot/config";
import { intervaloDoPeriodo, normalizarPeriodo } from "@/server/consumo/periodo";
import {
  agentesParaFiltro,
  lerLacunas,
  normalizarTipo,
} from "@/server/lacunas/consulta";
import { O_QUE_FORNECER, ROTULO_DO_TIPO } from "@/server/lacunas/regras";
import { BotaoApagarLacunas } from "@/components/botao-apagar-lacunas";
import { Filtros, type Campo } from "@/components/filtros";
import { Badge, EmptyState, PageHeader, Stat } from "@/components/ui";
import { formatarData } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Busca = {
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
 * que falta e APAGA a linha. Quem só lê vê a lista; apagar é de Administrador.
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
    lerLacunas({ intervalo, agentId: busca.agente ?? null, tipo }, quantidade),
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
      opcoes: QUANTIDADES.map((q) => ({ valor: q, rotulo: `${q} últimas` })),
    },
  ];

  const filtrado = Boolean(busca.periodo || busca.agente || busca.tipo);
  const totalDosTipos = Object.values(resumo.porTipo).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        titulo="Lacunas dos agentes"
        descricao="Cada vez que um agente passou o atendimento a uma pessoa por não conseguir resolver sozinho — por falta de instrução, de ferramenta ou por não ter entendido o pedido. É a lista do que fornecer para os agentes melhorarem. Apague a linha depois de tratada."
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          rotulo="No filtro"
          valor={resumo.total}
          detalhe={tipo ? ROTULO_DO_TIPO[tipo] : "todas as causas"}
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
              : "Nenhuma lacuna registrada"
          }
          descricao={
            filtrado
              ? totalDosTipos > 0
                ? "Tire um filtro: há lacunas fora deste recorte."
                : "Tire um filtro ou amplie o período."
              : "Quando um agente passar uma conversa a uma pessoa por não conseguir resolver sozinho, o que faltou aparece aqui."
          }
        />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">
              {resumo.itens.length < resumo.total
                ? `Mostrando as ${resumo.itens.length} mais recentes de ${resumo.total}.`
                : `${resumo.total} ${resumo.total === 1 ? "lacuna" : "lacunas"}.`}
            </p>
            {editavel ? (
              <BotaoApagarLacunas
                ids={resumo.itens.map((l) => l.id)}
                rotulo={`Apagar as ${resumo.itens.length} listadas`}
                confirmacao={`Apagar ${resumo.itens.length} ${resumo.itens.length === 1 ? "lacuna" : "lacunas"} da lista? Elas somem para toda a equipe e não dá para desfazer.`}
                tamanho="md"
              />
            ) : null}
          </div>

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
                      {formatarData(l.criadaEm)}
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
                    {editavel ? (
                      <div className="ml-auto">
                        <BotaoApagarLacunas
                          ids={[l.id]}
                          rotulo="Apagar"
                          confirmacao="Apagar esta lacuna da lista? Ela some para toda a equipe e não dá para desfazer."
                        />
                      </div>
                    ) : null}
                  </div>

                  <p className="mt-3 text-sm leading-relaxed font-medium">
                    {l.oQueFaltou || "O agente não disse o que faltou."}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    Motivo da passagem: {l.motivo}
                  </p>
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
