"use client";

import { useActionState } from "react";
import { salvarLimpezaDoContato, type EstadoLimpeza } from "@/server/actions/chatwoot";
import { Aviso, Button, Field, Textarea } from "@/components/ui";

/**
 * Limpeza dos campos do contato depois da resolução. Formulário PRÓPRIO, como as
 * ausências: salvar a lista não pode passar pelo liga/desliga da integração.
 */
export function LimpezaDoContatoForm({
  ligada,
  campos,
  nuncaLimpa,
  resumo,
  somenteLeitura,
}: {
  ligada: boolean;
  /** As chaves a limpar, uma por linha. */
  campos: string;
  nuncaLimpa: string;
  /** O que a limpeza fez nos últimos 7 dias, já em texto. */
  resumo: string | null;
  somenteLeitura: boolean;
}) {
  const [estado, acao, pendente] = useActionState<EstadoLimpeza, FormData>(
    salvarLimpezaDoContato,
    {},
  );

  return (
    <form action={acao} className="space-y-3 border-t border-line pt-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Limpar os campos do contato ao resolver</h3>
        <p className="text-xs leading-relaxed text-muted">
          15 minutos depois de a conversa ser resolvida, os campos abaixo saem do contato,
          para o próximo atendimento começar sem o canal, o produto ou as observações do
          anterior. Só limpa se a conversa continuar resolvida e o contato não tiver outra
          conversa em andamento. Dados pessoais nunca saem: {nuncaLimpa}.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="ligada"
          defaultChecked={ligada}
          disabled={somenteLeitura}
          className="size-4 accent-accent"
        />
        Limpeza ligada
      </label>

      <Field
        label="Campos que são limpos"
        hint="A CHAVE de cada atributo no Chatwoot, uma por linha (Configurações → Atributos personalizados). Ex.: canal, qualificao, observaes."
      >
        <Textarea
          name="campos"
          rows={7}
          defaultValue={campos}
          disabled={somenteLeitura}
          spellCheck={false}
        />
      </Field>

      {resumo ? <p className="text-xs text-muted">{resumo}</p> : null}
      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
      {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}

      {!somenteLeitura ? (
        <Button size="sm" disabled={pendente}>
          {pendente ? "Salvando…" : "Salvar limpeza"}
        </Button>
      ) : null}
    </form>
  );
}
