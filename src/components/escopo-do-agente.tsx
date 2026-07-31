"use client";

import { useActionState, useState } from "react";
import { Inbox } from "lucide-react";
import {
  salvarEscopoDoAgente,
  type EstadoEscopo,
} from "@/server/actions/chatwoot";
import { Aviso, Button, Card, Field, Input, Select } from "@/components/ui";
import { MINUTOS_PADRAO } from "@/server/queue/espera";

export function EscopoDoAgente({
  agentId,
  inboxMode,
  inboxIds,
  accountId,
  contaPadrao,
  temBot,
  fallbackMinutos,
  fallbackAtendente,
  somenteLeitura,
}: {
  agentId: string;
  inboxMode: string;
  inboxIds: number[];
  /** Conta própria do bot. Nulo = herda a da configuração global. */
  accountId: number | null;
  contaPadrao: number | null;
  temBot: boolean;
  fallbackMinutos: number | null;
  fallbackAtendente: string | null;
  somenteLeitura: boolean;
}) {
  const [estado, acao, pendente] = useActionState<EstadoEscopo, FormData>(
    salvarEscopoDoAgente.bind(null, agentId),
    {},
  );
  const [modo, setModo] = useState(inboxMode);

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Inbox size={15} aria-hidden className="text-muted" />
          Onde este agente atua
        </h2>
        <p className="text-xs text-muted">
          Restringe em quais caixas de entrada ele responde e em qual conta do
          Chatwoot o bot dele vive.
        </p>
      </div>

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

      <form action={acao} className="space-y-4">
        <Field
          label="Caixas de entrada"
          hint="Vale para o atendimento e para as transferências: um colega que não atua na caixa nem aparece como destino."
        >
          <Select
            name="inboxMode"
            value={modo}
            onChange={(e) => setModo(e.target.value)}
            disabled={somenteLeitura}
          >
            <option value="all">Todas as caixas</option>
            <option value="specific">Somente as caixas que eu listar</option>
          </Select>
        </Field>

        {modo === "specific" ? (
          <Field
            label="Ids das caixas"
            hint="Separados por vírgula. O id aparece na URL do Chatwoot ao abrir a caixa em Configurações → Caixas de entrada."
          >
            <Input
              name="inboxIds"
              defaultValue={inboxIds.join(", ")}
              placeholder="3, 5, 7"
              inputMode="numeric"
              disabled={somenteLeitura}
            />
          </Field>
        ) : (
          // Preserva a lista mesmo em "todas": voltar para específicas não deve
          // obrigar a redigitar tudo.
          <input type="hidden" name="inboxIds" value={inboxIds.join(",")} />
        )}

        <Field
          label="Conta do Chatwoot (opcional)"
          hint={
            contaPadrao
              ? `Em branco usa a conta ${contaPadrao}, definida em Integrações. Preencha só se este agente vive em outra conta da mesma instância.`
              : "Configure a instância em Integrações antes de usar uma conta própria."
          }
        >
          <Input
            name="accountId"
            defaultValue={accountId ?? ""}
            placeholder={contaPadrao ? String(contaPadrao) : "1"}
            inputMode="numeric"
            disabled={somenteLeitura}
          />
        </Field>

        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <Field
            label="Entregar a uma pessoa se demorar (minutos)"
            hint="Se o cliente ficar esperando mais que isso, a conversa vai para um humano. Cobre o que falha em silêncio: modelo pendurado, worker derrubado no meio do turno. Vazio usa o padrão."
          >
            <Input
              name="fallbackMinutos"
              type="number"
              min={1}
              max={120}
              defaultValue={fallbackMinutos ?? ""}
              placeholder={String(MINUTOS_PADRAO)}
              disabled={somenteLeitura}
            />
          </Field>

          <Field
            label="Para quem (opcional)"
            hint="Nome de quem assume nesse caso. Em branco, a conversa volta para a fila sem dono."
          >
            <Input
              name="fallbackAtendente"
              defaultValue={fallbackAtendente ?? ""}
              placeholder="Ex.: Basílio"
              disabled={somenteLeitura}
            />
          </Field>
        </div>

        {!temBot ? (
          <Aviso>
            Este agente ainda não tem bot. O escopo de caixas já vale para o
            roteamento, mas a conta só passa a valer depois de cadastrar o bot.
          </Aviso>
        ) : null}

        {!somenteLeitura ? (
          <Button size="sm" disabled={pendente}>
            {pendente ? "Salvando…" : "Salvar escopo"}
          </Button>
        ) : null}
      </form>
    </Card>
  );
}
