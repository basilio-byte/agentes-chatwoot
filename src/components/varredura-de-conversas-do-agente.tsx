"use client";

import { useActionState, useState, useTransition } from "react";
import { AlarmClock } from "lucide-react";
import {
  alternarVarredura,
  salvarVarredura,
  type EstadoGatilhoDeConversa,
  type ResumoDaVarredura,
} from "@/server/actions/gatilho-de-conversa";
import { EntregasDoWebhook, type Entrega } from "@/components/entregas-do-webhook";
import { Aviso, Badge, Button, Field, Input, Meta } from "@/components/ui";
import { Recolhivel, RecolhivelInterno } from "@/components/recolhivel";
import { formatarData } from "@/lib/utils";

const TOM_DO_RESULTADO: Record<string, "success" | "danger" | "neutral"> = {
  executado: "success",
  falhou: "danger",
  ignorado: "neutral",
  interrompido: "neutral",
};

/**
 * Gatilho "conversa parada": o relógio varre as conversas abertas da caixa e o
 * agente escreve uma nota interna em cada uma que está sem resposta.
 *
 * É o único gatilho de conversa com horário, e o único que age em conversa de
 * OUTRA pessoa — as duas coisas precisam estar ditas na tela, porque nenhuma
 * delas se deduz do nome.
 */
export function VarreduraDeConversasDoAgente({
  agentId,
  resumo,
  entregas,
  agenteAtivo,
  editavel,
}: {
  agentId: string;
  resumo: ResumoDaVarredura;
  entregas: Entrega[];
  agenteAtivo: boolean;
  editavel: boolean;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoGatilhoDeConversa, FormData>(
    salvarVarredura.bind(null, agentId),
    {},
  );
  const [resultado, setResultado] = useState<EstadoGatilhoDeConversa | null>(null);
  const [ocupado, iniciar] = useTransition();

  return (
    // A resposta do botão fica FORA do bloco: ele age com o bloco fechado, e a
    // recusa escrita lá dentro seria invisível.
    <div className="space-y-2">
      <Recolhivel
        icone={<AlarmClock size={15} aria-hidden />}
        titulo="Conversa parada"
        estado={
          resumo.enabled ? (
            <Badge tone="success">ligado</Badge>
          ) : (
            <Badge tone="neutral">desligado</Badge>
          )
        }
        acao={
          editavel ? (
            <Button
              size="sm"
              variant={resumo.enabled ? "secondary" : "primary"}
              disabled={ocupado}
              onClick={() =>
                iniciar(async () =>
                  setResultado(await alternarVarredura(agentId, !resumo.enabled)),
                )
              }
            >
              {resumo.enabled ? "Desligar" : "Ligar"}
            </Button>
          ) : null
        }
        resumo={
          resumo.cron
            ? `${resumo.cron} · paradas há mais de ${resumo.horasParadas}h`
            : "O relógio procura conversas sem resposta"
        }
        padraoAberto={resumo.enabled || entregas.length > 0}
      >
        <p className="text-sm leading-relaxed text-muted">
          No horário marcado, o sistema lista as conversas <strong>abertas e
          atribuídas a uma pessoa</strong> nas caixas do escopo deste agente (aba
          Canal) e, para cada uma que está sem resposta há tempo demais, roda o
          agente em segundo plano sobre o atendimento.{" "}
          <strong>Nada vai para o cliente</strong>: quem atende continua
          atendendo, e o agente só escreve nota interna para essa pessoa.
        </p>

        <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted">
          <li>
            O tempo parado conta pela <strong>última mensagem pública</strong>. A
            nota que o próprio agente deixa não reinicia essa contagem.
          </li>
          <li>
            Uma conversa só é analisada <strong>de novo quando houver mensagem
            nova</strong>. Sem isso, ela ficaria recebendo uma nota por dia.
          </li>
          <li>
            Antes de gastar o modelo, o sistema <strong>reconfere ao vivo</strong>:
            se alguém respondeu ou a conversa mudou de mãos, não escreve.
          </li>
          <li>
            Conversa que é só robô, saudação ou sem pessoa responsável fica de
            fora — o resumo da rodada diz quantas e por quê.
          </li>
        </ul>

        {!agenteAtivo && resumo.enabled ? (
          <Aviso tone="danger">
            O agente está desligado: a varredura roda e cada conversa vira uma
            entrega ignorada.
          </Aviso>
        ) : null}

        <form action={salvar} className="space-y-4 border-t border-line pt-4">
          <Field
            label="Quando varrer"
            hint="Expressão cron de 5 campos, sempre no horário de São Paulo. 0 7 * * * é todo dia às 7h."
          >
            <Input
              name="cron"
              defaultValue={resumo.cron ?? "0 7 * * *"}
              disabled={!editavel}
              placeholder="0 7 * * *"
            />
          </Field>

          {/* ⚠ Mostrar as próximas execuções é o que permite alguém notar um
              erro de fuso ANTES de ligar. O container roda em UTC. */}
          {resumo.proximas.length > 0 ? (
            <Meta className="block">
              Próximas: {resumo.proximas.map((d) => formatarData(d)).join(" · ")}
            </Meta>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Parada há mais de (horas)"
              hint="Contado da última mensagem pública da conversa."
            >
              <Input
                name="horasParadas"
                type="number"
                min={1}
                max={720}
                defaultValue={resumo.horasParadas}
                disabled={!editavel}
              />
            </Field>

            <Field
              label="Máximo de análises por rodada"
              hint="Teto de gasto: o que passar disso fica para a rodada seguinte."
            >
              <Input
                name="tetoPorRodada"
                type="number"
                min={1}
                max={500}
                defaultValue={resumo.tetoPorRodada}
                disabled={!editavel}
              />
            </Field>
          </div>

          {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
          {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

          {editavel ? (
            <Button size="sm" disabled={salvando}>
              {salvando ? "Salvando…" : "Salvar configuração"}
            </Button>
          ) : null}
        </form>

        {resumo.ultimaExecucaoEm ? (
          <Meta className="flex flex-wrap items-center gap-1.5">
            <Badge tone={TOM_DO_RESULTADO[resumo.ultimoResultado ?? ""] ?? "neutral"}>
              {resumo.ultimoResultado ?? "—"}
            </Badge>
            {formatarData(resumo.ultimaExecucaoEm)}
            {resumo.ultimoDetalhe ? ` · ${resumo.ultimoDetalhe}` : ""}
          </Meta>
        ) : (
          <Meta className="block">Ainda não rodou.</Meta>
        )}

        <RecolhivelInterno titulo="Como o agente recebe a conversa parada">
          <p className="text-sm text-muted">
            Uma mensagem por conversa — escreva o prompt sabendo este formato. A
            transcrição vai do fim do atendimento anterior até agora.
          </p>
          <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 text-xs">
{`[Conversa parada — o sistema varreu as conversas abertas e acionou este agente em segundo plano. Quem atende é a pessoa responsável abaixo, e ela continua atendendo. Nada do que você escrever vai para o cliente.]
Conversa: #13993
Link: https://…/app/accounts/1/conversations/13993
Contato: Maria
Telefone do contato: +558487654321
Responsável pela conversa: Arthur George
Quem da equipe respondeu ao cliente: Arthur George
Última mensagem: 15/09/2026 10:12 — o CLIENTE falou por último e ninguém da equipe respondeu desde então.
Parada há mais de 24 hora(s).

[transcrição do atendimento]
15/09 09:40 · Cliente: quero uma sala privativa para duas pessoas
15/09 09:55 · Atendente (Arthur George): temos sim, na unidade Ayrton Senna
15/09 10:12 · Cliente: e qual o valor?
[fim da transcrição]`}
          </pre>
        </RecolhivelInterno>

        <RecolhivelInterno titulo="Entregas recebidas" contador={entregas.length}>
          <EntregasDoWebhook
            semMoldura
            entregas={entregas}
            textoVazio={
              <>
                Nenhuma rodada ainda. Confira se o gatilho está{" "}
                <strong>ligado</strong> e se o <strong>token de leitura</strong> do
                Chatwoot está configurado em Integrações — sem ele a varredura não
                consegue listar conversa nenhuma.
              </>
            }
          />
        </RecolhivelInterno>
      </Recolhivel>

      {resultado?.ok ? <Aviso tone="success">{resultado.ok}</Aviso> : null}
      {resultado?.erro ? <Aviso tone="danger">{resultado.erro}</Aviso> : null}
    </div>
  );
}
