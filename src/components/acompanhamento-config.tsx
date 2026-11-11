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
          assinatura são confirmados. Uma seção por prédio, um documento por
          linha. Se o mesmo prédio atende mais de um produto, nomeie todos na
          mesma seção, separados por vírgula — assim os links existem uma vez
          só. O nome tem de ser igual ao da opção em{" "}
          <strong>TIPO DE PRODUTO</strong> no ClickUp.
        </p>
        <p className="text-sm text-muted">
          ⚠ Produto que não estiver nomeado em nenhuma seção recebe a mensagem{" "}
          <strong>sem</strong> links. É de propósito: esta lista é a mesma de
          SeaBox, sala privativa e Florânia, e mandar a documentação de Capim
          Macio a quem contratou outra coisa é pior do que não mandar nenhuma.
        </p>
        <textarea
          id="documentos"
          name="documentos"
          defaultValue={documentos}
          rows={10}
          spellCheck={false}
          disabled={somenteLeitura}
          placeholder={[
            "[Endereço Fiscal Litoral, Endereço Fiscal Batial]",
            "AVCB: https://…",
            "Habite-se: https://…",
            "",
            "[Endereço Fiscal Florânia]",
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
