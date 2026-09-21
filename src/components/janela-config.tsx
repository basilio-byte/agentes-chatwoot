"use client";

import { startTransition, useActionState, useState } from "react";
import { salvarConfigJanela, type EstadoJanela } from "@/server/actions/janela";
import { Aviso, Button, Field, Input, Textarea } from "@/components/ui";

/**
 * ⚠ O envio é por `onSubmit`, nunca por `<form action>`: o React 19 limpa o
 * formulário depois de todo envio por `action`, inclusive quando a gravação foi
 * recusada, e o checkbox voltaria desmarcado — salvar de novo desligaria a
 * função sem ninguém perceber. Mesmo conserto do alerta de saldo.
 */
export function JanelaConfigForm({
  habilitada,
  caixas,
  minutosDeAviso,
  instrucao,
  somenteLeitura,
}: {
  habilitada: boolean;
  caixas: string;
  minutosDeAviso: string;
  instrucao: string;
  somenteLeitura: boolean;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoJanela, FormData>(
    salvarConfigJanela,
    {},
  );

  const [ligada, setLigada] = useState(habilitada);
  const [valorCaixas, setCaixas] = useState(caixas);
  const [minutos, setMinutos] = useState(minutosDeAviso);
  const [texto, setTexto] = useState(instrucao);

  const enviar = (evento: React.FormEvent<HTMLFormElement>) => {
    evento.preventDefault();
    const dados = new FormData(evento.currentTarget);
    startTransition(() => salvar(dados));
  };

  return (
    <form onSubmit={enviar} className="space-y-5">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          checked={ligada}
          onChange={(e) => setLigada(e.target.checked)}
          disabled={somenteLeitura}
          className="size-4 accent-accent"
        />
        Conferência ligada
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Caixas"
          hint="Só as de WhatsApp oficial. A 31 e a 34 (WAHA) não têm janela."
        >
          <Input
            name="caixas"
            value={valorCaixas}
            onChange={(e) => setCaixas(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>
        <Field
          label="Avisar quantos minutos antes de fechar"
          hint="De 15 a 240. O fluxo do n8n avisava 60 minutos antes."
        >
          <Input
            name="minutosDeAviso"
            inputMode="numeric"
            value={minutos}
            onChange={(e) => setMinutos(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>
      </div>

      <Field
        label="O que a nota pede a quem atende"
        hint="Vem depois da linha com a hora em que a janela fecha, que o sistema escreve."
      >
        <Textarea
          name="instrucao"
          rows={2}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          disabled={somenteLeitura}
        />
      </Field>

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

      {somenteLeitura ? null : (
        <div className="flex justify-end">
          <Button type="submit" disabled={salvando}>
            {salvando ? "Salvando…" : "Salvar"}
          </Button>
        </div>
      )}
    </form>
  );
}
