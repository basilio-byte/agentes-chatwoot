"use client";

import { useActionState } from "react";
import { salvarConfigPrazos, type EstadoPrazos } from "@/server/actions/prazos";
import { Aviso, Button } from "@/components/ui";

export function PrazosConfigForm({
  habilitada,
  somenteLeitura,
}: {
  habilitada: boolean;
  somenteLeitura: boolean;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoPrazos, FormData>(
    salvarConfigPrazos,
    {},
  );

  return (
    <form action={salvar} className="space-y-4">
      <Aviso>
        Não há conta nem chave para configurar. Os prazos usam o Chatwoot do
        próprio agente e rodam no worker, no mesmo relógio do vigia.
      </Aviso>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={habilitada}
          disabled={somenteLeitura}
          className="size-4 accent-accent"
        />
        Integração ligada
      </label>

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

      {!somenteLeitura ? (
        <Button size="sm" disabled={salvando}>
          {salvando ? "Salvando…" : "Salvar"}
        </Button>
      ) : null}
    </form>
  );
}
