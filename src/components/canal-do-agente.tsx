"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRightLeft, DoorOpen, Plus } from "lucide-react";
import { ChatwootBotCard, type ResumoBot } from "@/components/chatwoot-bot";
import {
  EntregasDoWebhook,
  type Entrega,
} from "@/components/entregas-do-webhook";
import { Badge, Button, Card, Meta } from "@/components/ui";

/**
 * A aba Canal, organizada pela pergunta que quem configura realmente tem:
 * **como este agente recebe conversa?**
 *
 * São dois casos, e misturá-los confunde. O agente que é a **porta** de uma
 * caixa precisa de bot, token, secret e webhook. O que atende por
 * **transferência** não precisa de nada disso — responde pelo bot da porta.
 *
 * Mostrar o formulário de bot para todo mundo fazia parecer obrigatório, e
 * levava a criar bot para especialista que não usa (aconteceu na configuração
 * real, 2026-07-31). Agora o formulário só aparece para quem já é porta, ou
 * atrás de um clique explícito de quem quer tornar o agente uma.
 */
export function CanalDoAgente({
  agentId,
  agentName,
  resumo,
  urlWebhook,
  podeEditarCredencial,
  entregas,
}: {
  agentId: string;
  agentName: string;
  resumo: ResumoBot;
  urlWebhook: string;
  podeEditarCredencial: boolean;
  entregas: Entrega[];
}) {
  const ehPorta = resumo.configurado;
  const [configurando, setConfigurando] = useState(false);
  const mostrarFormulario = ehPorta || configurando;

  return (
    <div className="space-y-6">
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {ehPorta ? (
            <DoorOpen size={15} aria-hidden className="text-accent" />
          ) : (
            <ArrowRightLeft size={15} aria-hidden className="text-muted" />
          )}
          <h2 className="text-sm font-semibold">
            Como este agente recebe conversas
          </h2>
          <Badge tone={ehPorta ? "accent" : "neutral"}>
            {ehPorta ? "porta de uma caixa" : "por transferência"}
          </Badge>
        </div>

        {ehPorta ? (
          <p className="text-sm leading-relaxed text-muted">
            As mensagens de uma caixa de entrada do Chatwoot chegam direto neste
            agente, pelo bot{" "}
            <strong className="text-foreground">{resumo.botName}</strong>. Toda
            resposta da conversa sai por ele — inclusive quando quem atende é um
            colega que recebeu por transferência.
          </p>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-muted">
              Este agente é acionado por outro, quando o assunto é a
              especialidade dele. Ele responde pelo bot da porta, então{" "}
              <strong className="text-foreground">
                não precisa de bot próprio
              </strong>
              . Não há nada para configurar aqui.
            </p>
            <Meta className="block">
              Para ele receber transferências, o que importa é a descrição de
              roteamento, na aba{" "}
              <Link
                href={`/agentes/${agentId}?aba=agente`}
                className="underline"
              >
                Agente
              </Link>
              , e a equipe em{" "}
              <Link
                href={`/agentes/${agentId}?aba=equipe`}
                className="underline"
              >
                Equipe
              </Link>
              .
            </Meta>
          </>
        )}

        {!ehPorta && !configurando && podeEditarCredencial ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfigurando(true)}
            >
              <Plus size={14} aria-hidden />
              Tornar porta de uma caixa
            </Button>
            <Meta>
              Só se este agente for atender um número de WhatsApp próprio.
            </Meta>
          </div>
        ) : null}
      </Card>

      {mostrarFormulario ? (
        <ChatwootBotCard
          agentId={agentId}
          agentName={agentName}
          resumo={resumo}
          urlWebhook={urlWebhook}
          podeEditarCredencial={podeEditarCredencial}
        />
      ) : null}

      {/* Entregas só interessam a quem recebe direto — ou a quem já recebeu
          alguma coisa, para não esconder histórico. */}
      {mostrarFormulario || entregas.length > 0 ? (
        <EntregasDoWebhook entregas={entregas} />
      ) : null}
    </div>
  );
}
