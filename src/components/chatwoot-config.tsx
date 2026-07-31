"use client";

import { useActionState } from "react";
import {
  salvarConfigChatwoot,
  type EstadoChatwoot,
} from "@/server/actions/chatwoot";
import { Aviso, Button, Field, Input } from "@/components/ui";

export function ChatwootConfigForm({
  baseUrl,
  accountId,
  habilitada,
  somenteLeitura,
  temSecretDaConta,
  temTokenDeLeitura,
  urlWebhookConta,
}: {
  baseUrl: string;
  accountId: string;
  habilitada: boolean;
  somenteLeitura: boolean;
  temSecretDaConta: boolean;
  temTokenDeLeitura: boolean;
  urlWebhookConta: string;
}) {
  const [estado, acao, pendente] = useActionState<EstadoChatwoot, FormData>(
    salvarConfigChatwoot,
    {},
  );
  const erroDe = (c: string) => estado.camposComErro?.[c];

  return (
    <form action={acao} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="URL da instância"
          hint={erroDe("baseUrl") ?? "Ex.: https://chatwoot.seahealth.io"}
        >
          <Input
            name="baseUrl"
            defaultValue={baseUrl}
            placeholder="https://chatwoot.exemplo.com"
            disabled={somenteLeitura}
            required
          />
        </Field>

        <Field
          label="Id da conta"
          hint={
            erroDe("accountId") ??
            "O número na URL: /app/accounts/1/dashboard → 1"
          }
        >
          <Input
            name="accountId"
            type="number"
            min={1}
            defaultValue={accountId}
            disabled={somenteLeitura}
            required
          />
        </Field>
      </div>

      <Field
        label="Token de leitura"
        hint={
          temTokenDeLeitura
            ? "Já configurado. Preencha de novo só para rotacionar."
            : "OBRIGATÓRIO para o atendimento funcionar. O token do Agent Bot só ESCREVE — o Chatwoot recusa leitura de bot, e sem ler a conversa o agente não consegue nem aplicar as regras nem ver o histórico. Use o token de acesso de um usuário: Perfil → Configurações do perfil → Token de acesso."
        }
      >
        <Input
          name="tokenDeLeitura"
          type="password"
          placeholder={temTokenDeLeitura ? "••••••••" : "Token de acesso de um usuário"}
          disabled={somenteLeitura}
        />
      </Field>

      <Field
        label="Secret do webhook de conta (opcional)"
        hint={
          temSecretDaConta
            ? "Já configurado. Preencha de novo só para rotacionar."
            : "Sem ele, o histórico só é cortado quando alguém escreve na conversa. Ver instruções abaixo."
        }
      >
        <Input
          name="secretDaConta"
          type="password"
          placeholder={temSecretDaConta ? "••••••••" : ""}
          disabled={somenteLeitura}
        />
      </Field>

      <div className="rounded-lg border border-line bg-foreground/[0.02] p-3 text-xs leading-relaxed text-muted">
        <p className="mb-1 font-medium text-foreground">
          Corte de histórico ao resolver
        </p>
        <p>
          Em <strong>Configurações → Integrações → Webhooks</strong> do Chatwoot,
          cadastre o endereço abaixo assinando{" "}
          <code>conversation_status_changed</code> e{" "}
          <code>conversation_updated</code>, e cole aqui o secret que ele mostrar.
        </p>
        <code className="mt-1.5 block font-mono break-all">{urlWebhookConta}</code>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={habilitada}
          disabled={somenteLeitura}
          className="size-4"
        />
        Integração ligada (desligar aqui cala os bots de todos os agentes)
      </label>

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso>{estado.ok}</Aviso> : null}

      {!somenteLeitura ? (
        <Button type="submit" disabled={pendente}>
          {pendente ? "Salvando…" : "Salvar configuração"}
        </Button>
      ) : null}
    </form>
  );
}
