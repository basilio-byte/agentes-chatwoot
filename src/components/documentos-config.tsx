"use client";

import { useActionState, useState, useTransition } from "react";
import { Plug } from "lucide-react";
import {
  salvarConfigDocumentos,
  testarConexaoDocumentos,
  type EstadoDocumentos,
} from "@/server/actions/documentos";
import { Aviso, Button } from "@/components/ui";

export function DocumentosConfigForm({
  habilitada,
  somenteLeitura,
}: {
  habilitada: boolean;
  somenteLeitura: boolean;
}) {
  const [estado, salvar, salvando] = useActionState<EstadoDocumentos, FormData>(
    salvarConfigDocumentos,
    {},
  );
  const [teste, setTeste] = useState<EstadoDocumentos | null>(null);
  const [ocupado, iniciar] = useTransition();

  return (
    <form action={salvar} className="space-y-4">
      <Aviso>
        Não há conta nem chave para configurar. A conferência de CPF e CNH é{" "}
        <strong>offline</strong> (dígito verificador), e a consulta de CNPJ usa a
        base pública da Receita, gratuita e sem cadastro.
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
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={salvando}>
            {salvando ? "Salvando…" : "Salvar"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={ocupado}
            onClick={() => iniciar(async () => setTeste(await testarConexaoDocumentos()))}
          >
            <Plug size={14} aria-hidden />
            {ocupado ? "Testando…" : "Testar consulta de CNPJ"}
          </Button>
        </div>
      ) : null}

      {teste?.ok ? <Aviso tone="success">{teste.ok}</Aviso> : null}
      {teste?.erro ? <Aviso tone="danger">{teste.erro}</Aviso> : null}
    </form>
  );
}
