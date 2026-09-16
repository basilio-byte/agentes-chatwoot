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
import { Aviso, Badge, Button, Field, Meta, Textarea } from "@/components/ui";
import { Recolhivel, RecolhivelInterno } from "@/components/recolhivel";
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
    // ⚠ A resposta do botão fica FORA do bloco, e de propósito: o botão age com
    // o bloco fechado, e uma recusa ("ligue o agente antes") escrita lá dentro
    // seria invisível — clicar em Ligar e nada acontecer é indistinguível de um
    // botão quebrado.
    <div className="space-y-2">
      <Recolhivel
      icone={<MessagesSquare size={15} aria-hidden />}
      titulo="Conversa resolvida"
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
                setResultado(await alternarGatilhoDeConversa(agentId, !resumo.enabled)),
              )
            }
          >
            {resumo.enabled ? "Desligar" : "Ligar"}
          </Button>
        ) : null
      }
      resumo="Avalia o atendimento que acabou de ser resolvido"
      // Nasce aberto só quando há o que ver: ligado, ou já chegou entrega.
      padraoAberto={resumo.enabled || entregas.length > 0}
    >
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

      <RecolhivelInterno titulo="Como o agente recebe a conversa">
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
      </RecolhivelInterno>

      <RecolhivelInterno titulo="Entregas recebidas" contador={entregas.length}>
        <EntregasDoWebhook
          semMoldura
          entregas={entregas}
          textoVazio={
            <>
              Nenhuma conversa resolvida chegou ainda. Confira se o gatilho está{" "}
              <strong>ligado</strong> e se o <strong>webhook de conta</strong> do
              Chatwoot aponta para este sistema, assinando mudança de status.
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
