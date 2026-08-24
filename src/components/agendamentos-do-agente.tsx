"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { CalendarClock, Plus, Trash2 } from "lucide-react";
import {
  alternarAgendamento,
  excluirAgendamento,
  montarExpressao,
  preverAgendamento,
  salvarAgendamento,
  type AgendamentoNaTela,
  type EstadoAgendamento,
} from "@/server/actions/agendamentos";
import type { Atalho } from "@/server/agenda/cron";
import {
  Aviso,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Meta,
  Select,
  Textarea,
} from "@/components/ui";
import { formatarData } from "@/lib/utils";

const DIAS = [
  "domingo",
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
  "sábado",
];

const TOM_DO_RESULTADO: Record<string, "success" | "danger" | "neutral"> = {
  executado: "success",
  falhou: "danger",
  pulado: "neutral",
  interrompido: "neutral",
};

/** Formulário de um agendamento — serve para criar e para editar. */
function Formulario({
  agentId,
  inicial,
  onPronto,
}: {
  agentId: string;
  inicial?: AgendamentoNaTela;
  onPronto: () => void;
}) {
  const [estado, salvar, salvando] = useActionState<
    EstadoAgendamento,
    FormData
  >(salvarAgendamento.bind(null, agentId), {});

  const [cron, setCron] = useState(inicial?.cron ?? "0 9 * * *");
  const [previsao, setPrevisao] = useState<Date[] | null>(
    inicial?.proximas ?? null,
  );
  const [erroPrevisao, setErroPrevisao] = useState<string | null>(null);
  const [ocupado, iniciar] = useTransition();

  // Estado dos atalhos. Eles só MONTAM a expressão; a fonte da verdade continua
  // sendo o campo de texto, que fica visível e editável ao lado.
  const [atalho, setAtalho] = useState<Atalho>("diario");
  const [hora, setHora] = useState(9);
  const [minuto, setMinuto] = useState(0);
  const [diaDaSemana, setDiaDaSemana] = useState(1);
  const [diaDoMes, setDiaDoMes] = useState(1);
  const [aCadaHoras, setACadaHoras] = useState(6);

  const conferir = (expressao: string) =>
    iniciar(async () => {
      const r = await preverAgendamento(expressao);
      setPrevisao(r.proximas ?? null);
      setErroPrevisao(r.erro ?? null);
    });

  const aplicarAtalho = () =>
    iniciar(async () => {
      const expressao = await montarExpressao({
        atalho,
        hora,
        minuto,
        diaDaSemana,
        diaDoMes,
        aCadaHoras,
      });
      setCron(expressao);
      const r = await preverAgendamento(expressao);
      setPrevisao(r.proximas ?? null);
      setErroPrevisao(r.erro ?? null);
    });

  const erro = (campo: string) => estado.camposComErro?.[campo];

  // Fechar o formulário é `setState` do PAI: durante o render do filho o React
  // recusa ("cannot update a component while rendering a different one"). Tem
  // de acontecer depois da pintura.
  useEffect(() => {
    if (estado.ok) onPronto();
  }, [estado.ok, onPronto]);

  return (
    <form action={salvar} className="space-y-4 rounded-lg border border-line p-4">
      {inicial ? <input type="hidden" name="id" value={inicial.id} /> : null}

      <Field label="Nome" hint="Como aparece na lista e no histórico de disparos." erro={erro("nome")}>
        <Input name="nome" defaultValue={inicial?.nome ?? ""} placeholder="Resumo diário" />
      </Field>

      <div className="space-y-3 rounded-lg bg-surface-2 p-3">
        <p className="text-xs text-muted">
          Monte pelo atalho ou escreva a expressão à mão. O horário é sempre o de{" "}
          <strong>São Paulo</strong>.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Quando">
            <Select value={atalho} onChange={(e) => setAtalho(e.target.value as Atalho)}>
              <option value="diario">Todo dia</option>
              <option value="dias_uteis">De segunda a sexta</option>
              <option value="semanal">Uma vez por semana</option>
              <option value="mensal">Uma vez por mês</option>
              <option value="horas">A cada N horas</option>
            </Select>
          </Field>

          {atalho === "horas" ? (
            <Field label="A cada quantas horas">
              <Input
                type="number"
                min={1}
                max={23}
                value={aCadaHoras}
                onChange={(e) => setACadaHoras(Number(e.target.value))}
              />
            </Field>
          ) : atalho === "semanal" ? (
            <Field label="Dia da semana">
              <Select
                value={String(diaDaSemana)}
                onChange={(e) => setDiaDaSemana(Number(e.target.value))}
              >
                {DIAS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
          ) : atalho === "mensal" ? (
            <Field label="Dia do mês" hint="Máximo 28: acima disso o mês curto pularia.">
              <Input
                type="number"
                min={1}
                max={28}
                value={diaDoMes}
                onChange={(e) => setDiaDoMes(Number(e.target.value))}
              />
            </Field>
          ) : null}

          <Field label="Hora">
            <Input
              type="number"
              min={0}
              max={23}
              value={hora}
              onChange={(e) => setHora(Number(e.target.value))}
            />
          </Field>

          <Field label="Minuto">
            <Input
              type="number"
              min={0}
              max={59}
              value={minuto}
              onChange={(e) => setMinuto(Number(e.target.value))}
            />
          </Field>
        </div>

        <Button type="button" size="sm" variant="ghost" onClick={aplicarAtalho} disabled={ocupado}>
          Aplicar atalho
        </Button>
      </div>

      <Field
        label="Expressão"
        hint="Cinco campos: minuto hora dia mês dia-da-semana."
        erro={erro("cron") ?? erroPrevisao ?? undefined}
      >
        <Input
          name="cron"
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          onBlur={(e) => conferir(e.target.value)}
          className="font-mono"
        />
      </Field>

      {/* A conferência é a defesa contra o erro que não grita: expressão certa
          no fuso errado dispara três horas fora, todo dia, sem erro nenhum. */}
      {previsao?.length ? (
        <div className="rounded-lg border border-line bg-surface-2 p-3 text-xs">
          <p className="mb-1 text-muted">Próximas execuções:</p>
          <ul className="space-y-0.5 font-mono">
            {previsao.map((d) => (
              <li key={d.toISOString()}>{formatarData(d)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Field
        label="O que o agente deve fazer"
        hint="Vira a mensagem do turno. Não há cliente do outro lado: o que produz efeito são as ferramentas ligadas."
        erro={erro("instrucao")}
      >
        <Textarea
          name="instrucao"
          rows={4}
          defaultValue={inicial?.instrucao ?? ""}
          placeholder="Confira os contratos que vencem hoje e abra uma tarefa no ClickUp para cada um."
        />
      </Field>

      <Field
        label="Tolerância de atraso (minutos)"
        hint="Se a hora passar com o worker fora do ar, ainda executa dentro desta janela. Acima dela, pula e registra o motivo."
        erro={erro("toleranciaMinutos")}
      >
        <Input
          name="toleranciaMinutos"
          type="number"
          min={0}
          max={1440}
          defaultValue={inicial?.toleranciaMinutos ?? 60}
        />
      </Field>

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}

      <div className="flex gap-2">
        <Button size="sm" disabled={salvando}>
          {salvando ? "Salvando…" : inicial ? "Salvar alterações" : "Criar agendamento"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onPronto}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

export function AgendamentosDoAgente({
  agentId,
  agendamentos,
  agenteAtivo,
  editavel,
}: {
  agentId: string;
  agendamentos: AgendamentoNaTela[];
  agenteAtivo: boolean;
  editavel: boolean;
}) {
  const [criando, setCriando] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);
  const [resultado, setResultado] = useState<EstadoAgendamento | null>(null);
  const [ocupado, iniciar] = useTransition();

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarClock size={15} aria-hidden className="text-muted" />
        <h2 className="text-sm font-semibold">Agendamentos</h2>
        {editavel && !criando ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              setCriando(true);
              setEditando(null);
            }}
          >
            <Plus size={13} aria-hidden />
            Novo
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted">
        O agente roda sozinho na hora marcada, sem ninguém do outro lado. Ele age
        apenas pelas <strong>ferramentas ligadas</strong> — não consegue iniciar
        conversa no WhatsApp, porque não há conversa para responder.
      </p>

      {!agenteAtivo && agendamentos.some((a) => a.enabled) ? (
        <Aviso tone="danger">
          O agente está desligado: os agendamentos disparam e não fazem nada.
        </Aviso>
      ) : null}

      {resultado?.ok ? <Aviso tone="success">{resultado.ok}</Aviso> : null}
      {resultado?.erro ? <Aviso tone="danger">{resultado.erro}</Aviso> : null}

      {criando ? (
        <Formulario agentId={agentId} onPronto={() => setCriando(false)} />
      ) : null}

      {agendamentos.length === 0 && !criando ? (
        <EmptyState
          icone={<CalendarClock size={18} aria-hidden />}
          titulo="Nenhum agendamento"
          descricao="Crie um para o agente rodar sozinho — um resumo pela manhã, uma conferência no fim do dia."
        />
      ) : null}

      <div className="space-y-2">
        {agendamentos.map((a) =>
          editando === a.id ? (
            <Formulario
              key={a.id}
              agentId={agentId}
              inicial={a}
              onPronto={() => setEditando(null)}
            />
          ) : (
            <div key={a.id} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{a.nome}</span>
                {a.enabled ? (
                  <Badge tone="success">ligado</Badge>
                ) : (
                  <Badge>desligado</Badge>
                )}
                <code className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-muted">
                  {a.cron}
                </code>

                {editavel ? (
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditando(a.id);
                        setCriando(false);
                      }}
                    >
                      Editar
                    </Button>
                    <Button
                      size="sm"
                      variant={a.enabled ? "secondary" : "primary"}
                      disabled={ocupado}
                      onClick={() =>
                        iniciar(async () =>
                          setResultado(await alternarAgendamento(a.id, !a.enabled)),
                        )
                      }
                    >
                      {a.enabled ? "Desligar" : "Ligar"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={ocupado}
                      aria-label={`Excluir ${a.nome}`}
                      onClick={() =>
                        iniciar(async () =>
                          setResultado(await excluirAgendamento(a.id)),
                        )
                      }
                    >
                      <Trash2 size={13} aria-hidden />
                    </Button>
                  </div>
                ) : null}
              </div>

              {a.erroDoCron ? (
                <Aviso tone="danger">
                  A expressão guardada não é mais legível: {a.erroDoCron}. Este
                  agendamento não dispara até ser corrigido.
                </Aviso>
              ) : a.proximas.length ? (
                <Meta className="mt-1 block">
                  Próxima: {formatarData(a.proximas[0])}
                </Meta>
              ) : null}

              {a.pausadoAutomaticamenteMotivo ? (
                <Aviso tone="danger">
                  {a.pausadoAutomaticamenteMotivo}
                  {a.pausadoAutomaticamenteEm
                    ? ` em ${formatarData(a.pausadoAutomaticamenteEm)}`
                    : ""}
                  . Corrija a instrução e ligue de novo.
                </Aviso>
              ) : null}

              {a.ultimaExecucaoEm ? (
                <Meta className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge tone={TOM_DO_RESULTADO[a.ultimoResultado ?? ""] ?? "neutral"}>
                    {a.ultimoResultado ?? "—"}
                  </Badge>
                  {formatarData(a.ultimaExecucaoEm)}
                  {a.ultimoDetalhe ? ` · ${a.ultimoDetalhe}` : ""}
                </Meta>
              ) : (
                <Meta className="mt-1 block">Ainda não rodou.</Meta>
              )}
            </div>
          ),
        )}
      </div>
    </Card>
  );
}
