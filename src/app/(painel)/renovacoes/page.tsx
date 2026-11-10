import { AlertTriangle, CalendarClock, ExternalLink } from "lucide-react";

import { Filtros, type Campo } from "@/components/filtros";
import { Badge, Card, EmptyState, PageHeader, Stat } from "@/components/ui";
import { exigirSessao } from "@/server/auth-guard";
import {
  lerLeva,
  levaPadrao,
  mesesParaEscolher,
  type LinhaDaRenovacao,
} from "@/server/renovacao/consulta";
import { STATUS_NOTIFICACAO, STATUS_PG_PENDENTE, STATUS_RENOVACAO } from "@/server/renovacao/regras";

export const dynamic = "force-dynamic";

/**
 * Renovação de contratos: a leva do mês, como a planilha mostra — e o que a
 * planilha não mostra.
 *
 * A leva sai da **fidelidade do contrato no Conexa**, não da `DATA DE REAJUSTE`
 * do ClickUp: essa continua preenchida em cliente que já saiu, e listar por ela
 * traz tarefa de quem não tem mais contrato.
 *
 * Esta tela **não escreve em nada**. É o retrato que a equipe confere antes de
 * o sistema encostar em qualquer campo.
 */

const MESES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

function rotuloDoMes(mes: string) {
  const [ano, m] = mes.split("-");
  return `${MESES[Number(m) - 1]} de ${ano}`;
}

function dia(iso: string | null) {
  if (!iso) return "—";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

function reais(valor: number | null | undefined) {
  if (valor == null) return "—";
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const TOM_DO_STATUS: Record<string, "accent" | "warning" | "success" | "neutral"> = {
  [STATUS_RENOVACAO]: "accent",
  [STATUS_NOTIFICACAO]: "accent",
  [STATUS_PG_PENDENTE]: "warning",
};

function Linha({ linha, hoje }: { linha: LinhaDaRenovacao; hoje: string }) {
  const vencida = !!linha.fidelidade && linha.fidelidade < hoje;

  return (
    <tr className="border-t border-line align-top">
      <td className="py-3 pr-4">
        <div className="font-medium">
          {linha.nome ?? `Cliente ${linha.clienteId}`}
        </div>
        <div className="text-xs text-muted">
          {linha.plano ?? "—"}
          {linha.outrasTarefas > 0 && (
            <>
              {" · "}
              <span className="text-warning">
                +{linha.outrasTarefas} tarefa{linha.outrasTarefas > 1 ? "s" : ""} do mesmo
                cliente
              </span>
            </>
          )}
        </div>
      </td>

      <td className="py-3 pr-4 whitespace-nowrap">
        <span className={vencida ? "text-danger" : undefined}>{dia(linha.fidelidade)}</span>
      </td>

      <td className="py-3 pr-4 text-right tabular-nums whitespace-nowrap">
        {reais(linha.anterior?.valor)}
        {linha.anterior?.origem === "deduzido" && (
          <div className="text-[11px] text-muted">deduzido</div>
        )}
      </td>
      <td className="py-3 pr-4 text-right tabular-nums whitespace-nowrap">
        {reais(linha.valor)}
      </td>
      <td className="py-3 pr-4 text-right tabular-nums whitespace-nowrap">
        {reais(linha.diferenca)}
      </td>

      <td className="py-3 pr-4 whitespace-nowrap">
        {linha.reajusteEm ? (
          <>
            {dia(linha.reajusteEm)}
            <div className="text-[11px] text-muted">
              {linha.reajusteIndice ?? "—"}
              {linha.reajustePct != null && ` ${linha.reajustePct}%`}
            </div>
          </>
        ) : (
          <span className="text-muted">sem reajuste</span>
        )}
      </td>

      <td className="py-3">
        {linha.tarefa ? (
          <a
            className="inline-flex items-center gap-1 hover:underline"
            href={linha.tarefa.url}
            target="_blank"
            rel="noreferrer"
          >
            <Badge tone={TOM_DO_STATUS[linha.tarefa.status] ?? "neutral"}>
              {linha.tarefa.status}
            </Badge>
            <ExternalLink className="size-3 text-muted" />
          </a>
        ) : (
          <span className="text-xs text-muted">fora do fluxo</span>
        )}
      </td>
    </tr>
  );
}

function Tabela({ linhas, hoje }: { linhas: LinhaDaRenovacao[]; hoje: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="pb-2 pr-4 font-medium">Cliente</th>
            <th className="pb-2 pr-4 font-medium">Fidelidade</th>
            <th className="pb-2 pr-4 text-right font-medium">Valor anterior</th>
            <th className="pb-2 pr-4 text-right font-medium">Valor</th>
            <th className="pb-2 pr-4 text-right font-medium">Dif./mês</th>
            <th className="pb-2 pr-4 font-medium">Último reajuste</th>
            <th className="pb-2 font-medium">No ClickUp</th>
          </tr>
        </thead>
        <tbody>
          {linhas.map((l) => (
            <Linha key={l.contratoId} linha={l} hoje={hoje} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function RenovacoesPage({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string }>;
}) {
  await exigirSessao();
  const busca = await searchParams;

  const meses = mesesParaEscolher();
  const mes = busca.mes && meses.includes(busca.mes) ? busca.mes : levaPadrao();
  const leva = await lerLeva(mes);

  const hoje = new Date().toISOString().slice(0, 10);
  const reajustados = leva.linhas.filter((l) => l.reajusteEm).length;
  const foraDoFluxo = leva.linhas.filter((l) => !l.tarefa).length;
  const somaDif = leva.linhas.reduce((s, l) => s + (l.diferenca ?? 0), 0);

  const campos: Campo[] = [
    {
      tipo: "select",
      chave: "mes",
      rotulo: "Leva",
      opcoes: meses.map((m) => ({ valor: m, rotulo: rotuloDoMes(m) })),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        titulo="Renovação de contratos"
        descricao="A leva do mês vem da data de fidelidade do contrato no Conexa. Esta tela não altera nada — é só leitura."
      />

      {(leva.erros.length > 0 || !leva.conexaCompleto || !leva.clickupCompleto) && (
        <Card className="border-warning/40">
          <div className="flex gap-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="space-y-1">
              {!leva.conexaCompleto && (
                <p>
                  A lista de contratos do Conexa veio <strong>incompleta</strong>: a leva pode
                  ter mais contratos do que os mostrados.
                </p>
              )}
              {!leva.clickupCompleto && (
                <p>
                  A lista de tarefas do ClickUp veio <strong>incompleta</strong>: pode haver
                  tarefa no fluxo que não apareceu aqui.
                </p>
              )}
              {leva.erros.map((erro) => (
                <p key={erro}>A leitura falhou — {erro}</p>
              ))}
            </div>
          </div>
        </Card>
      )}

      <Filtros campos={campos} valores={{ mes }} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat rotulo="Contratos na leva" valor={leva.linhas.length} destaque />
        <Stat
          rotulo="Já reajustados"
          valor={reajustados}
          detalhe={`${leva.linhas.length - reajustados} aguardando o lote`}
        />
        <Stat
          rotulo="Fora do fluxo"
          valor={foraDoFluxo}
          detalhe="sem tarefa num status de renovação"
        />
        <Stat
          rotulo="Diferença por mês"
          valor={reais(somaDif)}
          detalhe="soma do que a leva acrescenta"
        />
      </div>

      <Card className="space-y-4">
        <h2 className="text-sm font-medium">Leva de {rotuloDoMes(mes)}</h2>
        {leva.linhas.length ? (
          <Tabela linhas={leva.linhas} hoje={hoje} />
        ) : (
          <EmptyState
            icone={<CalendarClock className="size-5" />}
            titulo="Nenhum contrato com fidelidade neste mês"
            descricao="Troque a leva no filtro acima."
          />
        )}
      </Card>

      {leva.atrasados.length > 0 && (
        <Card className="space-y-4">
          <div>
            <h2 className="text-sm font-medium">
              Fidelidade vencida · {leva.atrasados.length}
            </h2>
            <p className="text-xs text-muted">
              Contratos ativos cuja fidelidade já passou e que ninguém fechou.
            </p>
          </div>
          <Tabela linhas={leva.atrasados} hoje={hoje} />
        </Card>
      )}

      {leva.orfas.length > 0 && (
        <Card className="space-y-4">
          <div>
            <h2 className="text-sm font-medium">
              Tarefas no fluxo sem contrato na leva · {leva.orfas.length}
            </h2>
            <p className="text-xs text-muted">
              Estão num status de renovação, mas o contrato delas não vence neste mês — ou o
              cliente já não tem contrato ativo.
            </p>
          </div>
          <ul className="space-y-1 text-sm">
            {leva.orfas.map((t) => (
              <li key={t.id}>
                <a
                  className="inline-flex items-center gap-1 hover:underline"
                  href={t.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t.nome}
                  <ExternalLink className="size-3 text-muted" />
                </a>{" "}
                <Badge tone={TOM_DO_STATUS[t.status] ?? "neutral"}>{t.status}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
