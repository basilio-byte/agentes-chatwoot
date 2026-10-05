"use client";

import { startTransition, useActionState, useState } from "react";
import {
  salvarConfigNotasFiscais,
  type EstadoNotasFiscais,
} from "@/server/actions/notas-fiscais";
import { Aviso, Button, Field, Input, Textarea } from "@/components/ui";

export type LinhaDeCategoria = {
  id: number;
  nome: string;
  /** Nomes das unidades do Conexa a que a categoria pertence. */
  empresas: string;
  ativa: boolean;
  codigo: string;
  /** Tem código gravado, mas o Conexa não a devolveu agora. */
  sumiu?: boolean;
};

/**
 * ⚠ O envio é por `onSubmit`, nunca por `<form action>`: o React 19 limpa o
 * formulário depois de todo envio por `action`, inclusive quando a gravação foi
 * recusada. Mesmo conserto da cobrança, da janela e do alerta de saldo.
 */
export function NotasFiscaisConfigForm({
  habilitada,
  inicio,
  categorias,
  codigoReservaDeSala,
  clientes,
  produtos,
  somenteLeitura,
}: {
  habilitada: boolean;
  inicio: string;
  categorias: LinhaDeCategoria[];
  codigoReservaDeSala: string;
  clientes: string;
  produtos: string;
  somenteLeitura: boolean;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoNotasFiscais, FormData>(
    salvarConfigNotasFiscais,
    {},
  );

  const [ligada, setLigada] = useState(habilitada);
  const [dia, setDia] = useState(inicio);
  const [codigos, setCodigos] = useState<Record<number, string>>(
    Object.fromEntries(categorias.map((c) => [c.id, c.codigo])),
  );
  const [sala, setSala] = useState(codigoReservaDeSala);
  const [regras, setRegras] = useState(clientes);
  const [produtosTexto, setProdutosTexto] = useState(produtos);

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
        Modo sombra ligado
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Cobranças pagas a partir de"
          hint="Vazio = a partir de hoje. A conferência nunca volta mais que 7 dias."
        >
          <Input
            type="date"
            name="inicio"
            value={dia}
            onChange={(e) => setDia(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>
        <Field
          label="Código da reserva de sala"
          hint="O item de reserva não tem categoria no Conexa: o “produto” dele é a sala."
        >
          <Input
            name="codigoReservaDeSala"
            placeholder="03.03.02"
            value={sala}
            onChange={(e) => setSala(e.target.value)}
            disabled={somenteLeitura}
          />
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium">Código de serviço por categoria do Conexa</legend>
        <p className="text-xs text-muted">
          Categoria sem código deixa a cobrança <strong>aguardando classificação</strong>: o
          código nunca é adivinhado. Formato 03.03.02.
        </p>
        {categorias.length === 0 ? (
          <p className="text-sm text-muted">Nenhuma categoria para mostrar.</p>
        ) : (
          <div className="divide-y divide-line rounded-lg border border-line">
            {categorias.map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{c.nome}</span>
                  <span className="ml-2 text-xs text-muted tabular-nums">#{c.id}</span>
                  <span className="block truncate text-xs text-muted">
                    {[c.empresas, c.ativa ? null : "inativa", c.sumiu ? "não veio do Conexa agora" : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <Input
                  name={`codigo_${c.id}`}
                  aria-label={`Código de ${c.nome}`}
                  placeholder="sem código"
                  value={codigos[c.id] ?? ""}
                  onChange={(e) => setCodigos((atual) => ({ ...atual, [c.id]: e.target.value }))}
                  disabled={somenteLeitura}
                  className="w-32 shrink-0 tabular-nums"
                />
              </div>
            ))}
          </div>
        )}
      </fieldset>

      <Field
        label="Regras por produto"
        hint={
          <>
            Vencem a categoria. Uma por linha: id do produto no Conexa, espaço, e{" "}
            <strong>sem nota</strong> (não leva nota de serviço), <strong>conferir</strong> (uma
            pessoa decide) ou um código como <code>03.03.02</code>, e uma observação opcional. Ex.:{" "}
            <code>2799 sem nota Red Bull</code>. Só vale para produto do cadastro — não para
            reserva de sala.
          </>
        }
      >
        <Textarea
          name="produtos"
          rows={6}
          value={produtosTexto}
          onChange={(e) => setProdutosTexto(e.target.value)}
          disabled={somenteLeitura}
          className="font-mono text-[13px]"
        />
      </Field>

      <Field
        label="Regras por cliente"
        hint={
          <>
            Uma por linha: id do cliente no Conexa, espaço, <strong>antes</strong> (nota na
            geração da cobrança) ou <strong>nunca</strong> (sem nota automática), e uma
            observação opcional. Ex.: <code>3245 antes paga depois de receber a nota</code>.
          </>
        }
      >
        <Textarea
          name="clientes"
          rows={5}
          value={regras}
          onChange={(e) => setRegras(e.target.value)}
          disabled={somenteLeitura}
          className="font-mono text-[13px]"
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
