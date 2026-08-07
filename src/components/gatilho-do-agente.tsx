"use client";

import { useState, useTransition } from "react";
import { Check, Copy, RefreshCw, Webhook } from "lucide-react";
import {
  alternarGatilho,
  gerarOuRotacionarToken,
  type EstadoGatilho,
  type ResumoGatilho,
} from "@/server/actions/gatilho";
import {
  EntregasDoWebhook,
  type Entrega,
} from "@/components/entregas-do-webhook";
import { Aviso, Badge, Button, Card, Input, Meta } from "@/components/ui";
import { formatarData } from "@/lib/utils";

/**
 * Aba Gatilho: aciona este agente por POST de um sistema externo (ClickUp,
 * n8n, curl), fora de uma conversa do Chatwoot.
 *
 * O token nasce do NOSSO lado — diferente de toda outra credencial do painel,
 * que o operador cola de um sistema que já existe. Por isso ele é mostrado em
 * texto puro só uma vez, logo após gerar/rotacionar, e nunca mais: exatamente
 * como qualquer chave de API (Stripe, GitHub). O componente guarda esse valor
 * só em estado local — some no reload, de propósito.
 */
export function GatilhoDoAgente({
  agentId,
  urlBase,
  resumo,
  entregas,
  somenteLeitura,
  podeEditarCredencial,
}: {
  agentId: string;
  /** `https://host/api/webhooks/gatilho/<agentId>` — falta só o token. */
  urlBase: string;
  resumo: ResumoGatilho;
  entregas: Entrega[];
  somenteLeitura: boolean;
  podeEditarCredencial: boolean;
}) {
  const [tokenNovo, setTokenNovo] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [estado, setEstado] = useState<EstadoGatilho | null>(null);
  const [ocupado, iniciar] = useTransition();

  const urlCompleta = `${urlBase}/${tokenNovo ?? "••••••••••••••••••••••••••••"}`;

  function copiar() {
    navigator.clipboard.writeText(urlCompleta);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }

  return (
    <div className="space-y-6">
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Webhook size={15} aria-hidden className="text-muted" />
          <h2 className="text-sm font-semibold">Gatilho HTTP externo</h2>
          {!resumo.configurado ? (
            <Badge>sem token</Badge>
          ) : resumo.pausadoAutomaticamenteMotivo ? (
            <Badge tone="danger">pausado automaticamente</Badge>
          ) : resumo.enabled ? (
            <Badge tone="success">ligado</Badge>
          ) : (
            <Badge tone="neutral">desligado</Badge>
          )}
        </div>

        <p className="text-sm leading-relaxed text-muted">
          Aciona este agente diretamente por uma chamada HTTP de fora — um
          webhook configurado no ClickUp, no n8n, ou qualquer sistema capaz de
          fazer um POST. Não passa pelo Chatwoot: não há cliente nem conversa,
          só o payload que chegou. O agente age através das tools que tiver
          ligadas na aba Integrações — o prompt dele decide o que fazer com
          cada tipo de evento.
        </p>

        {resumo.pausadoAutomaticamenteMotivo ? (
          <Aviso tone="danger">
            O sistema desligou o gatilho sozinho
            {resumo.pausadoAutomaticamenteEm
              ? ` em ${formatarData(resumo.pausadoAutomaticamenteEm)}`
              : ""}
            : {resumo.pausadoAutomaticamenteMotivo}. Confira se o sistema
            externo não entrou num laço (o agente reagindo ao próprio efeito
            de uma tool) antes de ligar de novo.
          </Aviso>
        ) : null}

        <div className="space-y-1">
          <span className="text-sm font-medium">URL do gatilho</span>
          <div className="flex gap-2">
            <Input readOnly value={urlCompleta} className="font-mono text-xs" />
            <Button
              type="button"
              variant="secondary"
              disabled={!tokenNovo}
              onClick={copiar}
            >
              {copiado ? <Check size={14} /> : <Copy size={14} />}
              {copiado ? "Copiado" : "Copiar"}
            </Button>
          </div>
          {tokenNovo ? (
            <Aviso tone="danger">
              <strong>Copie agora.</strong> Esta é a única vez que o token
              aparece por inteiro — cole-o no sistema externo antes de sair
              desta página.
            </Aviso>
          ) : null}
        </div>

        {podeEditarCredencial ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={ocupado}
              onClick={() =>
                iniciar(async () => {
                  const r = await gerarOuRotacionarToken(agentId);
                  setEstado(r);
                  if (r.tokenPlano) setTokenNovo(r.tokenPlano);
                })
              }
            >
              <RefreshCw size={14} aria-hidden />
              {ocupado
                ? "Gerando…"
                : resumo.configurado
                  ? "Rotacionar token"
                  : "Gerar token"}
            </Button>

            {resumo.configurado && !somenteLeitura ? (
              <form action={alternarGatilho.bind(null, agentId, !resumo.enabled)}>
                <Button variant="secondary" size="sm">
                  {resumo.enabled ? "Desligar" : "Ligar"}
                </Button>
              </form>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted">
            Só o papel OWNER gera ou rotaciona o token.
          </p>
        )}

        {estado?.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
        {estado?.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

        {resumo.hint ? (
          <p className="text-xs text-muted">
            Token salvo: {resumo.hint}
            {resumo.rotatedAt
              ? ` · atualizado em ${formatarData(resumo.rotatedAt)}`
              : ""}
          </p>
        ) : null}
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold">Como o agente recebe o evento</h2>
        <p className="text-sm text-muted">
          Cada POST vira uma mensagem para o modelo, com o payload em JSON —
          escreva o prompt do agente sabendo este formato:
        </p>
        <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 text-xs">
{`[Gatilho HTTP externo — evento "taskCreated", fora de uma conversa
do Chatwoot. Aja conforme suas instruções para este tipo de evento;
não há cliente esperando resposta em texto.]

Payload recebido (JSON):
{
  "event": "taskCreated",
  "task_id": "abc123",
  ...
}`}
        </pre>
        <Meta className="block">
          Exemplo de chamada de teste:{" "}
          <code className="font-mono">
            curl -X POST {urlBase}/&lt;token&gt; -H &quot;Content-Type:
            application/json&quot; -d {"'"}
            {"{"}&quot;event&quot;:&quot;teste&quot;{"}"}
            {"'"}
          </code>
        </Meta>
      </Card>

      <EntregasDoWebhook
        entregas={entregas}
        textoVazio={
          <>
            Nada chegou ainda. Confira se o sistema externo está apontando
            para a <strong>URL do gatilho</strong> acima e se ela está{" "}
            <strong>ligada</strong>.
          </>
        }
        textoSegredoQuebrado={
          <>
            A última entrega foi recusada por token. O{" "}
            <strong>token do gatilho</strong> configurado no sistema externo
            não confere com o daqui — gere um novo e atualize lá.
          </>
        }
      />
    </div>
  );
}
