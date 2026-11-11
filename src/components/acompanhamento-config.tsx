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
  documentos,
  somenteLeitura,
}: {
  habilitada: boolean;
  documentos: string;
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

      <div className="space-y-2">
        <label htmlFor="documentos" className="block text-sm font-medium">
          Documentação do endereço, por produto
        </label>
        <p className="text-sm text-muted">
          Estes links vão ao cliente no WhatsApp quando o pagamento e a
          assinatura são confirmados. Um produto por seção, um documento por
          linha. Produto sem seção aqui recebe a mensagem <strong>sem</strong>{" "}
          links — melhor isso do que a documentação do prédio errado.
        </p>
        <textarea
          id="documentos"
          name="documentos"
          defaultValue={documentos}
          rows={10}
          spellCheck={false}
          disabled={somenteLeitura}
          placeholder={[
            "[Endereço Fiscal Litoral]",
            "AVCB: https://…",
            "Habite-se: https://…",
            "",
            "[Endereço Fiscal Batial]",
            "AVCB: https://…",
          ].join("\n")}
          className="w-full rounded border border-borda bg-fundo px-3 py-2 font-mono text-xs"
        />
        <p className="text-sm text-muted">
          ⚠ O original é a automação do ClickBot, que manda esses mesmos
          documentos por e-mail. Mudou lá, mude aqui também — são dois lugares.
        </p>
      </div>

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
