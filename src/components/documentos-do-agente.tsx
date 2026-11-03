"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { FileText } from "lucide-react";
import {
  definirDocumentosDoAgenteNaTela,
  type EstadoDoVinculo,
} from "@/server/actions/conhecimento";
import {
  AVISO_A_PARTIR_DE_TOKENS,
  MAX_CARACTERES_POR_AGENTE,
  tokensDoTexto,
} from "@/server/conhecimento/regras";
import { Aviso, Badge, Button, Card, Meta } from "@/components/ui";
import { cn } from "@/lib/utils";

export type DocumentoParaOAgente = {
  id: string;
  nome: string;
  descricao: string | null;
  setor: string | null;
  caracteres: number;
};

/**
 * Os documentos que ESTE agente recebe, com o peso de cada um e o total.
 *
 * É o outro lado do vínculo da tela Documentos, e existe pelo mesmo motivo de a
 * aba Integrações do agente existir: quem está olhando um agente quer ver tudo
 * que entra no prompt dele. O custo aparece em tokens por mensagem — documento
 * é pago em toda mensagem, e quem liga não deveria descobrir isso na fatura.
 */
export function DocumentosDoAgente({
  agentId,
  documentos,
  vinculados,
  editavel,
}: {
  agentId: string;
  documentos: DocumentoParaOAgente[];
  vinculados: string[];
  editavel: boolean;
}) {
  const [marcados, setMarcados] = useState<string[]>(vinculados);
  const [resultado, setResultado] = useState<EstadoDoVinculo | null>(null);
  const [ocupado, iniciar] = useTransition();

  const escolhidos = documentos.filter((d) => marcados.includes(d.id));
  const caracteres = escolhidos.reduce((soma, d) => soma + d.caracteres, 0);
  const tokens = tokensDoTexto(caracteres);
  const passouDoTeto = caracteres > MAX_CARACTERES_POR_AGENTE;
  const mudou =
    marcados.length !== vinculados.length ||
    marcados.some((id) => !vinculados.includes(id));

  const alternar = (id: string) => {
    setResultado(null);
    setMarcados((atual) =>
      atual.includes(id) ? atual.filter((m) => m !== id) : [...atual, id],
    );
  };

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Documentos deste agente</h2>
        <p className="text-xs text-muted">
          O texto de cada documento marcado entra no prompt deste agente, logo
          depois do prompt dele e antes das Regras da Casa, em toda mensagem. Os
          documentos são escritos e editados na tela{" "}
          <Link href="/documentos" className="underline">
            Documentos
          </Link>
          .
        </p>
      </div>

      {resultado?.erro ? <Aviso tone="danger">{resultado.erro}</Aviso> : null}
      {resultado?.ok ? <Aviso tone="success">{resultado.ok}</Aviso> : null}

      {documentos.length === 0 ? (
        <p className="text-sm text-muted">
          Nenhum documento cadastrado ainda. Crie o primeiro em{" "}
          <Link href="/documentos" className="underline">
            Documentos
          </Link>
          .
        </p>
      ) : (
        <ul className="space-y-1.5">
          {documentos.map((d) => (
            <li key={d.id}>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line p-2.5">
                <input
                  type="checkbox"
                  checked={marcados.includes(d.id)}
                  onChange={() => alternar(d.id)}
                  disabled={!editavel}
                  className="mt-0.5 size-3.5 shrink-0 accent-accent"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <FileText size={13} aria-hidden className="text-muted" />
                    <span className="text-sm font-medium">{d.nome}</span>
                    {d.setor ? <Badge>{d.setor}</Badge> : null}
                    <Meta>
                      ~{tokensDoTexto(d.caracteres).toLocaleString("pt-BR")} tokens
                    </Meta>
                  </span>
                  {d.descricao ? (
                    <Meta className="mt-0.5 block">{d.descricao}</Meta>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {documentos.length > 0 ? (
        <div className="space-y-3">
          <Meta className={cn("block", passouDoTeto && "font-medium text-danger")}>
            {escolhidos.length} de {documentos.length} marcados · ~
            {tokens.toLocaleString("pt-BR")} tokens a mais em cada mensagem
            {passouDoTeto
              ? ` — passa do teto de ${MAX_CARACTERES_POR_AGENTE.toLocaleString("pt-BR")} caracteres por agente`
              : ""}
          </Meta>

          {tokens >= AVISO_A_PARTIR_DE_TOKENS && !passouDoTeto ? (
            <Aviso tone="warning">
              Os documentos marcados pesam cerca de{" "}
              {tokens.toLocaleString("pt-BR")} tokens, pagos em toda mensagem
              deste agente. Desmarque o que ele não usa.
            </Aviso>
          ) : null}

          {editavel ? (
            <Button
              size="sm"
              disabled={ocupado || !mudou || passouDoTeto}
              onClick={() =>
                iniciar(async () =>
                  setResultado(
                    await definirDocumentosDoAgenteNaTela(agentId, marcados),
                  ),
                )
              }
            >
              {ocupado ? "Salvando…" : "Salvar documentos"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
