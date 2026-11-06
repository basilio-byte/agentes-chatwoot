"use client";

import { useActionState } from "react";
import { salvarAusencias, type EstadoAusencias } from "@/server/actions/chatwoot";
import { Aviso, Button, Field, Textarea } from "@/components/ui";

/**
 * Ausências da equipe. Formulário PRÓPRIO, e não parte do da instância: ligar ou
 * desligar a integração e trocar a URL são decisões de outro peso, e salvar uma
 * ausência não pode passar por elas.
 */
export function AusenciasDaEquipeForm({
  texto,
  vigentes,
  somenteLeitura,
}: {
  /** As ausências guardadas, uma por linha (`ausenciasEmTexto`). */
  texto: string;
  /** Resumo do que vale HOJE, já calculado no servidor. */
  vigentes: string[];
  somenteLeitura: boolean;
}) {
  const [estado, acao, pendente] = useActionState<EstadoAusencias, FormData>(
    salvarAusencias,
    {},
  );

  return (
    <form action={acao} className="space-y-3 border-t border-line pt-4">
      <Field
        label="Ausências da equipe"
        hint={
          <>
            Uma por linha: <code>nome -&gt; substituto até dd/mm/aaaa</code>. Ex.:{" "}
            <code>Laercio -&gt; Felipe até 19/11/2026</code>. Enquanto vale, tudo que os
            agentes, a cobrança, o vigia e os prazos atribuiriam à pessoa vai para o
            substituto. Vale até o <strong>fim</strong> do último dia e termina sozinha;
            o que já está atribuído não é movido.
          </>
        }
      >
        <Textarea
          name="ausencias"
          rows={3}
          defaultValue={texto}
          placeholder="Laercio -> Felipe até 19/11/2026"
          disabled={somenteLeitura}
          spellCheck={false}
        />
      </Field>

      <p className="text-xs text-muted">
        {vigentes.length > 0
          ? `Valendo agora: ${vigentes.join("; ")}.`
          : "Nenhuma ausência valendo agora."}
      </p>

      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso>{estado.ok}</Aviso> : null}

      {!somenteLeitura ? (
        <Button type="submit" disabled={pendente}>
          {pendente ? "Salvando…" : "Salvar ausências"}
        </Button>
      ) : null}
    </form>
  );
}
