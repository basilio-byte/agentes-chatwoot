"use client";

import { useActionState } from "react";
import { salvarLeadNoCrm, type EstadoLeadNoCrm } from "@/server/actions/chatwoot";
import { Aviso, Button, Field, Input, Select, Textarea } from "@/components/ui";

/**
 * Registro automático do lead no CRM Comercial. Formulário PRÓPRIO, como a
 * limpeza do contato: salvar aqui não passa pelo liga/desliga da integração.
 */
export function LeadNoCrmForm({
  modo,
  agentes,
  agenteDoCrm,
  resumo,
  somenteLeitura,
}: {
  modo: "desligado" | "sombra" | "ligado";
  /** As chaves dos agentes comerciais, uma por linha. */
  agentes: string;
  agenteDoCrm: string;
  /** O que o registro fez nos últimos 7 dias, já em texto. */
  resumo: string | null;
  somenteLeitura: boolean;
}) {
  const [estado, acao, pendente] = useActionState<EstadoLeadNoCrm, FormData>(
    salvarLeadNoCrm,
    {},
  );

  return (
    <form action={acao} className="space-y-3 border-t border-line pt-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Registrar o lead no CRM Comercial</h3>
        <p className="text-xs leading-relaxed text-muted">
          Quando o robô passa a conversa a um dos agentes comerciais abaixo (o cliente
          escolheu o serviço), o sistema acompanha: assim que ela estiver com uma pessoa da
          equipe e ainda sem task no CRM, aciona o agente de CRM em segundo plano, como se o
          checkbox passar_para_crm tivesse sido marcado — o vendedor é quem está com a
          conversa. Não registra se já há task, se virou suporte ou enquanto o robô conduz
          (venda e abandono já têm o próprio registro). Em sombra, só anota o que faria.
        </p>
      </div>

      <Field label="Situação">
        <Select name="modo" defaultValue={modo} disabled={somenteLeitura}>
          <option value="desligado">Desligado</option>
          <option value="sombra">Sombra (só anota)</option>
          <option value="ligado">Ligado</option>
        </Select>
      </Field>

      <Field
        label="Agentes comerciais"
        hint="A CHAVE de cada agente, uma por linha, como aparece na tela dele."
      >
        <Textarea
          name="agentes"
          rows={5}
          defaultValue={agentes}
          disabled={somenteLeitura}
          spellCheck={false}
        />
      </Field>

      <Field label="Agente de CRM" hint="Quem cria a task. A chave dele.">
        <Input
          name="agenteDoCrm"
          defaultValue={agenteDoCrm}
          disabled={somenteLeitura}
          spellCheck={false}
        />
      </Field>

      {resumo ? <p className="text-xs text-muted">{resumo}</p> : null}
      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

      {!somenteLeitura ? (
        <Button size="sm" disabled={pendente}>
          {pendente ? "Salvando…" : "Salvar registro do lead"}
        </Button>
      ) : null}
    </form>
  );
}
