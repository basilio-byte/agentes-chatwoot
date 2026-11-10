"use client";

import { startTransition, useActionState, useState } from "react";

import {
  salvarConfigAcompanhamento,
  type EstadoAcompanhamento,
} from "@/server/actions/acompanhamento";
import { Aviso, Button } from "@/components/ui";

/**
 * O liga/desliga do acompanhamento de contratos.
 *
 * ⚠ O envio é por `onSubmit`, nunca por `<form action>`: o React 19 limpa o
 * formulário depois de todo envio por `action`, inclusive quando a gravação foi
 * recusada. Mesmo conserto da janela, do alerta de saldo e da cobrança.
 */
export function AcompanhamentoConfigForm({
  habilitada,
  somenteLeitura,
}: {
  habilitada: boolean;
  somenteLeitura: boolean;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoAcompanhamento, FormData>(
    salvarConfigAcompanhamento,
    {},
  );

  const [ligada, setLigada] = useState(habilitada);

  const enviar = (evento: React.FormEvent<HTMLFormElement>) => {
    evento.preventDefault();
    const dados = new FormData(evento.currentTarget);
    startTransition(() => salvar(dados));
  };

  return (
    <form onSubmit={enviar} className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          checked={ligada}
          onChange={(e) => setLigada(e.target.checked)}
          disabled={somenteLeitura}
          className="size-4 accent-accent"
        />
        Acompanhamento ligado
      </label>

      {ligada && !habilitada ? (
        <Aviso tone="warning">
          Ao salvar, o sistema passa a <strong>escrever para o cliente</strong> na
          conversa em que o vendedor está atendendo. Ele espera quando alguém
          acabou de falar ali, e deixa uma nota interna a cada mensagem.
        </Aviso>
      ) : null}

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

      {!somenteLeitura ? (
        <Button type="submit" disabled={salvando}>
          {salvando ? "Salvando…" : "Salvar"}
        </Button>
      ) : null}
    </form>
  );
}
