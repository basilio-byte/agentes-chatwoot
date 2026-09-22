"use client";

import { startTransition, useActionState, useState } from "react";
import { salvarConfigCobranca, type EstadoCobranca } from "@/server/actions/cobranca";
import { Aviso, Button, Field, Input, Textarea } from "@/components/ui";

/**
 * ⚠ O envio é por `onSubmit`, nunca por `<form action>`: o React 19 limpa o
 * formulário depois de todo envio por `action`, inclusive quando a gravação foi
 * recusada. Mesmo conserto da janela e do alerta de saldo.
 */
export function CobrancaConfigForm({
  habilitada,
  caixaId,
  aposEnviar,
  atribuirA,
  mensagem1,
  mensagem2,
  somenteLeitura,
}: {
  habilitada: boolean;
  caixaId: string;
  aposEnviar: "resolver" | "atribuir";
  atribuirA: string;
  mensagem1: string;
  mensagem2: string;
  somenteLeitura: boolean;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoCobranca, FormData>(
    salvarConfigCobranca,
    {},
  );

  const [ligada, setLigada] = useState(habilitada);
  const [caixa, setCaixa] = useState(caixaId);
  const [depois, setDepois] = useState(aposEnviar);
  const [quem, setQuem] = useState(atribuirA);
  const [texto1, setTexto1] = useState(mensagem1);
  const [texto2, setTexto2] = useState(mensagem2);

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
        Envio ligado
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Caixa de saída" hint="A 31 (número alternativo). A 29 exigiria template aprovado pela Meta.">
          <Input
            name="caixaId"
            inputMode="numeric"
            value={caixa}
            onChange={(e) => setCaixa(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium">Depois do envio</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="aposEnviar"
            value="atribuir"
            checked={depois === "atribuir"}
            onChange={() => setDepois("atribuir")}
            disabled={somenteLeitura}
            className="mt-0.5 size-4 accent-accent"
          />
          <span>Atribuir a conversa a uma pessoa (só se ninguém estiver com ela)</span>
        </label>
        {depois === "atribuir" ? (
          <Input
            name="atribuirA"
            aria-label="Atribuir a conversa a"
            placeholder="Nome como está no Chatwoot"
            value={quem}
            onChange={(e) => setQuem(e.target.value)}
            disabled={somenteLeitura}
            className="ml-6 block w-auto sm:w-72"
          />
        ) : (
          // O nome fica guardado para quando voltarem a atribuir.
          <input type="hidden" name="atribuirA" value={quem} />
        )}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="aposEnviar"
            value="resolver"
            checked={depois === "resolver"}
            onChange={() => setDepois("resolver")}
            disabled={somenteLeitura}
            className="mt-0.5 size-4 accent-accent"
          />
          <span>
            Resolver a conversa — a automação cuida sozinha.
            <span className="block text-xs text-muted">
              Se o cliente responder, a conversa volta para a fila da caixa. Conversa
              com dono, ou que já estava aberta antes do envio, não é resolvida.
            </span>
          </span>
        </label>
      </fieldset>

      <Field label='Mensagem da etiqueta "cobranca-1"'>
        <Textarea
          name="mensagem1"
          rows={4}
          value={texto1}
          onChange={(e) => setTexto1(e.target.value)}
          disabled={somenteLeitura}
        />
      </Field>
      <Field label='Mensagem da etiqueta "cobranca-2"'>
        <Textarea
          name="mensagem2"
          rows={4}
          value={texto2}
          onChange={(e) => setTexto2(e.target.value)}
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
