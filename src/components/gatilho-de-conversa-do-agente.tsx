"use client";

import { useActionState, useState, useTransition } from "react";
import { MessagesSquare } from "lucide-react";
import {
  alternarGatilhoDeConversa,
  salvarGatilhoDeConversa,
  type EstadoGatilhoDeConversa,
  type ResumoGatilhoDeConversa,
} from "@/server/actions/gatilho-de-conversa";
import {
  EntregasDoWebhook,
  type Entrega,
} from "@/components/entregas-do-webhook";
import { Aviso, Badge, Button, Card, Field, Meta, Textarea } from "@/components/ui";
import { formatarData } from "@/lib/utils";

const TOM_DO_RESULTADO: Record<string, "success" | "danger" | "neutral"> = {
  executado: "success",
  falhou: "danger",
  ignorado: "neutral",
  interrompido: "neutral",
};

/**
 * Gatilho "conversa resolvida": o agente roda em segundo plano sobre o
 * atendimento que acabou de ser resolvido no Chatwoot.
 *
 * As caixas não aparecem aqui de propósito: valem as do escopo do agente, na aba
 * Canal. Duas listas de caixas para o mesmo agente divergiriam.
 */
export function GatilhoDeConversaDoAgente({
  agentId,
  resumo,
  entregas,
  agenteAtivo,
  editavel,
}: {
  agentId: string;
  resumo: ResumoGatilhoDeConversa;
  entregas: Entrega[];
  agenteAtivo: boolean;
  editavel: boolean;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoGatilhoDeConversa, FormData>(
    salvarGatilhoDeConversa.bind(null, agentId),
    {},
  );
  const [resultado, setResultado] = useState<EstadoGatilhoDeConversa | null>(null);
  const [ocupado, iniciar] = useTransition();

  return (
    <div className="space-y-6">
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <MessagesSquare size={15} aria-hidden className="text-muted" />
          <h2 className="text-sm font-semibold">Quando uma conversa é resolvida</h2>
          {resumo.enabled ? (
            <Badge tone="success">ligado</Badge>
          ) : (
            <Badge tone="neutral">desligado</Badge>
          )}

          {editavel ? (
            <Button
              size="sm"
              variant={resumo.enabled ? "secondary" : "primary"}
              className="ml-auto"
              disabled={ocupado}
              onClick={() =>
                iniciar(async () =>
                  setResultado(await alternarGatilhoDeConversa(agentId, !resumo.enabled)),
                )
              }
            >
              {resumo.enabled ? "Desligar" : "Ligar"}
            </Button>
          ) : null}
        </div>

        <p className="text-sm leading-relaxed text-muted">
          Toda vez que uma conversa é resolvida no Chatwoot, em qualquer caixa do
          escopo deste agente (aba Canal), ele roda em segundo plano sobre a
          transcrição daquele atendimento. <strong>Nada vai para o cliente</strong>:
          o agente age só pelas ferramentas ligadas — por exemplo, avaliar o
          atendimento e gravar a nota no CRM.
        </p>

        {!agenteAtivo && resumo.enabled ? (
          <Aviso tone="danger">
            O agente está desligado: as conversas resolvidas chegam e são ignoradas.
          </Aviso>
        ) : null}

        {resultado?.ok ? <Aviso tone="success">{resultado.ok}</Aviso> : null}
        {resultado?.erro ? <Aviso tone="danger">{resultado.erro}</Aviso> : null}

        <form action={salvar} className="space-y-4 border-t border-line pt-4">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="exigeAtendimentoHumano"
              defaultChecked={resumo.exigeAtendimentoHumano}
              disabled={!editavel}
              className="mt-0.5"
            />
            <span>
              Só quando <strong>uma pessoa da equipe</strong> respondeu ao cliente.
              <Meta className="block">
                Conferido antes de chamar o modelo: atendimento só de robô, só de
                nota interna ou só de automação não custa nada.
              </Meta>
            </span>
          </label>

          <Field
            label="Contas que não contam como pessoa"
            hint="Uma por linha, com o nome como aparece no Chatwoot. Use para as contas cujo token é usado por automação."
          >
            <Textarea
              name="contasDeAutomacao"
              rows={3}
              defaultValue={resumo.contasDeAutomacao.join("\n")}
              disabled={!editavel}
              placeholder="Basílio Oliveira"
            />
          </Field>

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
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold">Como o agente recebe a conversa</h2>
        <p className="text-sm text-muted">
          Uma mensagem por atendimento resolvido — escreva o prompt sabendo este
          formato. A transcrição vai do fim do atendimento anterior até esta
          resolução.
        </p>
        <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 text-xs">
{`[Conversa encerrada no Chatwoot — o sistema acionou este agente em segundo plano. Nada do que você escrever vai para o cliente.]
Conversa: #12345
Link: https://…/app/accounts/1/conversations/12345
Resolvida em: 15/09/2026 12:17
Contato: Maria
Telefone do contato: +558487654321
Quem da equipe respondeu ao cliente: Regis Costa

[transcrição do atendimento]
15/09 11:02 · Cliente: quero reservar uma sala
15/09 11:03 · Robô: Claro! Para qual dia?
15/09 11:20 · Atendente (Regis Costa): Oi, aqui é o Regis…
15/09 11:21 · Nota interna (Regis Costa): reserva feita no Conexa
15/09 12:17 · Sistema: Conversa foi marcada como resolvida por Regis Costa
[fim da transcrição]`}
        </pre>
      </Card>

      <EntregasDoWebhook
        entregas={entregas}
        textoVazio={
          <>
            Nenhuma conversa resolvida chegou ainda. Confira se o gatilho está{" "}
            <strong>ligado</strong> e se o <strong>webhook de conta</strong> do
            Chatwoot aponta para este sistema, assinando mudança de status.
          </>
        }
      />
    </div>
  );
}
