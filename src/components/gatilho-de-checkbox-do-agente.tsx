"use client";

import { useActionState, useState, useTransition } from "react";
import { ListChecks } from "lucide-react";
import {
  alternarGatilhoDeCheckbox,
  salvarGatilhoDeCheckbox,
  type EstadoGatilhoDeConversa,
  type ResumoGatilhoDeCheckbox,
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
 * Gatilho "checkbox marcado": alguém da equipe marca um atributo da conversa no
 * Chatwoot e o agente roda em segundo plano sobre o atendimento atual — a
 * passagem manual para os CRMs.
 *
 * As caixas não aparecem aqui, pelo mesmo motivo do cartão de conversa
 * resolvida: valem as do escopo do agente, na aba Canal.
 */
export function GatilhoDeCheckboxDoAgente({
  agentId,
  resumo,
  entregas,
  agenteAtivo,
  editavel,
}: {
  agentId: string;
  resumo: ResumoGatilhoDeCheckbox;
  entregas: Entrega[];
  agenteAtivo: boolean;
  editavel: boolean;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoGatilhoDeConversa, FormData>(
    salvarGatilhoDeCheckbox.bind(null, agentId),
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
      icone={<ListChecks size={15} aria-hidden />}
      titulo="Checkbox marcado"
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
                setResultado(await alternarGatilhoDeCheckbox(agentId, !resumo.enabled)),
              )
            }
          >
            {resumo.enabled ? "Desligar" : "Ligar"}
          </Button>
        ) : null
      }
      resumo={
        resumo.atributos.length > 0
          ? resumo.atributos.join(", ")
          : "A equipe manda a conversa para este agente"
      }
      padraoAberto={resumo.enabled || entregas.length > 0}
    >
        <p className="text-sm leading-relaxed text-muted">
          Quando alguém da equipe marca um dos checkboxes abaixo numa conversa do
          Chatwoot, em qualquer caixa do escopo deste agente (aba Canal), ele roda
          em segundo plano sobre o atendimento atual.{" "}
          <strong>Nada vai para o cliente</strong>: o agente age só pelas
          ferramentas ligadas.
        </p>

        <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted">
          <li>
            O sistema <strong>desmarca o checkbox na hora</strong>, sem apagar os
            outros campos da conversa.
          </li>
          <li>
            Conversa <strong>sem uma pessoa responsável</strong> não roda: fica uma
            nota interna pedindo para atribuir e marcar de novo.
          </li>
          <li>
            Se este agente <strong>já criou uma task</strong> no ClickUp nesta
            conversa nos últimos 30 dias, não roda de novo: a nota traz o link.
          </li>
          <li>
            As notas saem pelo robô da caixa. Em caixa sem o robô, o desfecho fica
            só nas entregas abaixo.
          </li>
        </ul>

        {!agenteAtivo && resumo.enabled ? (
          <Aviso tone="danger">
            O agente está desligado: os checkboxes marcados chegam e são ignorados.
          </Aviso>
        ) : null}

        <form action={salvar} className="space-y-4 border-t border-line pt-4">
          <Field
            label="Checkboxes que acionam este agente"
            hint="A chave do atributo da conversa, como está no Chatwoot (Configurações → Atributos personalizados), uma por linha."
          >
            <Textarea
              name="atributos"
              rows={3}
              defaultValue={resumo.atributos.join("\n")}
              disabled={!editavel}
              placeholder="passar_para_crm"
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

      <RecolhivelInterno titulo="Como o agente recebe a conversa marcada">
        <p className="text-sm text-muted">
          Uma mensagem por checkbox marcado — escreva o prompt sabendo este
          formato. A transcrição vai do fim do atendimento anterior até a
          marcação; se a conversa já estava resolvida, é o atendimento que
          terminou nela.
        </p>
        <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 text-xs">
{`[Checkbox marcado no Chatwoot — alguém da equipe marcou um campo nesta conversa e o sistema acionou este agente em segundo plano. Nada do que você escrever vai para o cliente.]
Checkbox marcado: passar_para_crm
Conversa: #12345
Link: https://…/app/accounts/1/conversations/12345
Marcado em: 15/09/2026 13:28
Contato: Maria
Telefone do contato: +558487654321
Dono da conversa no Chatwoot: Regis Costa
Quem da equipe respondeu ao cliente: Regis Costa

[transcrição do atendimento]
15/09 11:02 · Cliente: quero reservar o auditório
15/09 11:03 · Robô: Claro! Para qual dia?
15/09 11:20 · Atendente (Regis Costa): Oi, aqui é o Regis…
15/09 13:28 · Sistema: Sistema de Automação adicionou crm_clickup
[fim da transcrição]`}
        </pre>
      </RecolhivelInterno>

      <RecolhivelInterno titulo="Entregas recebidas" contador={entregas.length}>
        <EntregasDoWebhook
          semMoldura
          entregas={entregas}
          textoVazio={
            <>
              Nenhum checkbox marcado chegou ainda. Confira se o gatilho está{" "}
              <strong>ligado</strong> e se o <strong>webhook de conta</strong> do
              Chatwoot aponta para este sistema, assinando atualização de conversa.
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
