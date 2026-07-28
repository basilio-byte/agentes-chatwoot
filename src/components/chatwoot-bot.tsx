"use client";

import { useActionState, useState, useTransition } from "react";
import { Check, Copy, Plug } from "lucide-react";
import {
  salvarBotDoAgente,
  testarConexaoDoAgente,
  type EstadoChatwoot,
} from "@/server/actions/chatwoot";
import { Aviso, Badge, Button, Card, Field, Input } from "@/components/ui";
import { formatarData } from "@/lib/utils";

export type ResumoBot = {
  configurado: boolean;
  botName: string;
  botId: number | null;
  hint: string | null;
  rotatedAt: Date | string | null;
  instanciaOk: boolean;
  habilitadaGlobalmente: boolean;
};

export function ChatwootBotCard({
  agentId,
  agentName,
  resumo,
  urlWebhook,
  podeEditarCredencial,
}: {
  agentId: string;
  agentName: string;
  resumo: ResumoBot;
  urlWebhook: string;
  podeEditarCredencial: boolean;
}) {
  const [estado, acao, pendente] = useActionState<EstadoChatwoot, FormData>(
    salvarBotDoAgente.bind(null, agentId),
    {},
  );
  const [teste, setTeste] = useState<EstadoChatwoot | null>(null);
  const [testando, iniciarTeste] = useTransition();
  const [copiado, setCopiado] = useState(false);

  return (
    <Card className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Bot do Chatwoot</h2>
        {resumo.configurado ? (
          <Badge tone="success">configurado</Badge>
        ) : (
          <Badge>não configurado</Badge>
        )}
        {resumo.configurado && !resumo.habilitadaGlobalmente ? (
          <Badge tone="danger">integração desligada</Badge>
        ) : null}
      </div>

      <p className="text-sm text-muted">
        Cada agente tem o próprio bot, com nome e avatar dele no Chatwoot. Crie em{" "}
        <strong>Configurações → Bots → Adicionar bot</strong> e aponte a URL do
        webhook abaixo.
      </p>

      <div className="space-y-1">
        <span className="text-sm font-medium">URL do webhook deste agente</span>
        <div className="flex gap-2">
          <Input readOnly value={urlWebhook} className="font-mono text-xs" />
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              navigator.clipboard.writeText(urlWebhook);
              setCopiado(true);
              setTimeout(() => setCopiado(false), 2000);
            }}
          >
            {copiado ? <Check size={14} /> : <Copy size={14} />}
            {copiado ? "Copiado" : "Copiar"}
          </Button>
        </div>
      </div>

      {!resumo.instanciaOk ? (
        <Aviso tone="danger">
          A URL da instância e o id da conta ainda não foram salvos em
          Integrações. O bot não funciona sem eles.
        </Aviso>
      ) : null}

      <form action={acao} className="space-y-4 border-t border-line pt-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Nome do bot no Chatwoot"
            hint={estado.camposComErro?.botName}
          >
            <Input
              name="botName"
              defaultValue={resumo.botName || `Atendente ${agentName}`}
              disabled={!podeEditarCredencial}
              required
            />
          </Field>

          <Field
            label="Id do bot (opcional)"
            hint={
              estado.camposComErro?.botId ??
              "Número do bot no Chatwoot. Ajuda a ignorar o próprio eco."
            }
          >
            <Input
              name="botId"
              type="number"
              min={1}
              defaultValue={resumo.botId ?? ""}
              disabled={!podeEditarCredencial}
            />
          </Field>
        </div>

        <Field
          label="Access token do bot"
          hint={
            estado.camposComErro?.token ??
            (resumo.hint
              ? `Salvo: ${resumo.hint}. Preencha de novo só para rotacionar.`
              : "Aparece ao criar o bot no Chatwoot.")
          }
        >
          <Input
            name="token"
            type="password"
            placeholder={resumo.hint ? "••••••••" : ""}
            disabled={!podeEditarCredencial}
            required
          />
        </Field>

        <Field
          label="Secret do webhook"
          hint={
            estado.camposComErro?.webhookSecret ??
            "Mostrado uma vez na criação; dá para rever no formulário de edição do bot. Sem ele, toda entrega é recusada."
          }
        >
          <Input
            name="webhookSecret"
            type="password"
            disabled={!podeEditarCredencial}
          />
        </Field>

        {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
        {estado.ok ? <Aviso>{estado.ok}</Aviso> : null}

        {podeEditarCredencial ? (
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={pendente}>
              {pendente ? "Salvando…" : "Salvar bot"}
            </Button>

            <Button
              type="button"
              variant="secondary"
              disabled={testando || !resumo.configurado}
              onClick={() =>
                iniciarTeste(async () =>
                  setTeste(await testarConexaoDoAgente(agentId)),
                )
              }
            >
              <Plug size={14} aria-hidden />
              {testando ? "Testando…" : "Testar conexão"}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted">
            Só o papel OWNER edita credenciais.
          </p>
        )}
      </form>

      {teste?.erro ? <Aviso tone="danger">{teste.erro}</Aviso> : null}
      {teste?.ok ? <Aviso>{teste.ok}</Aviso> : null}

      {resumo.rotatedAt ? (
        <p className="text-xs text-muted">
          Credencial atualizada em {formatarData(resumo.rotatedAt)}.
        </p>
      ) : null}
    </Card>
  );
}
