"use client";

import { startTransition, useActionState, useState } from "react";
import { salvarConfigMateriais, type EstadoMateriais } from "@/server/actions/materiais";
import { Aviso, Button, Field, Textarea } from "@/components/ui";

/**
 * ⚠ O envio é por `onSubmit`, nunca por `<form action>`: o React 19 limpa o
 * formulário depois de todo envio por `action`, inclusive quando a gravação foi
 * recusada. Mesmo conserto da janela e do alerta de saldo.
 */
export function MateriaisConfigForm({
  habilitada,
  prefixos,
  somenteLeitura,
}: {
  habilitada: boolean;
  prefixos: string;
  somenteLeitura: boolean;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoMateriais, FormData>(
    salvarConfigMateriais,
    {},
  );

  const [ligada, setLigada] = useState(habilitada);
  const [texto, setTexto] = useState(prefixos);

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
        Integração ligada
      </label>

      <Field
        label="Macros que viram material"
        hint="Um prefixo por linha. Entra todo macro global com imagem cujo nome começa por ele — [SR] pega todas as salas de reunião. Linha com - na frente tira da lista: -[SA] Promoção."
      >
        <Textarea
          name="prefixos"
          rows={6}
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
