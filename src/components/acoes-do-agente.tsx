"use client";

import { useState, useTransition } from "react";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import {
  arquivarAgente,
  excluirAgente,
  impactoDaExclusao,
  restaurarAgente,
  type EstadoArquivo,
} from "@/server/actions/agents";
import { Aviso, Button } from "@/components/ui";

/**
 * Arquivar, restaurar e excluir, direto na listagem.
 *
 * Arquivar é a ação em destaque; excluir fica atrás de uma confirmação que diz
 * o que vai embora junto — a exclusão cascateia para as execuções do agente, e
 * com elas some o histórico de custo e de tool calls.
 */
export function AcoesDoAgente({
  agenteId,
  nome,
  arquivado,
}: {
  agenteId: string;
  nome: string;
  arquivado: boolean;
}) {
  const [estado, setEstado] = useState<EstadoArquivo | null>(null);
  const [confirmando, setConfirmando] = useState<{
    execucoes: number;
    conversas: number;
    versoes: number;
  } | null>(null);
  const [ocupado, iniciar] = useTransition();

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        {arquivado ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={ocupado}
            onClick={() =>
              iniciar(async () => setEstado(await restaurarAgente(agenteId)))
            }
          >
            <ArchiveRestore size={14} aria-hidden />
            Restaurar
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            title="Tira de circulação e desliga, mantendo prompt e histórico"
            disabled={ocupado}
            onClick={() =>
              iniciar(async () => setEstado(await arquivarAgente(agenteId)))
            }
          >
            <Archive size={14} aria-hidden />
            Arquivar
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          title="Excluir definitivamente"
          className="text-muted hover:text-danger"
          disabled={ocupado}
          onClick={() =>
            iniciar(async () => setConfirmando(await impactoDaExclusao(agenteId)))
          }
        >
          <Trash2 size={14} aria-hidden />
        </Button>
      </div>

      {estado?.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}
      {estado?.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}

      {confirmando ? (
        <div className="space-y-2 rounded-lg border border-danger/30 bg-danger/[0.04] p-3 text-left">
          <p className="text-[13px] leading-relaxed">
            Excluir <strong>{nome}</strong> apaga também{" "}
            <strong>{confirmando.execucoes} execução(ões)</strong> e{" "}
            <strong>{confirmando.versoes} versão(ões)</strong> do prompt. Não tem
            volta.
          </p>
          {confirmando.conversas > 0 ? (
            <p className="text-xs text-muted">
              As {confirmando.conversas} conversa(s) continuam, mas ficam sem
              agente.
            </p>
          ) : null}
          <p className="text-xs text-muted">
            Se a ideia é só tirar de circulação, arquive: mantém tudo e dá para
            voltar.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <form action={excluirAgente.bind(null, agenteId)}>
              <Button variant="danger" size="sm">
                Excluir definitivamente
              </Button>
            </form>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmando(null)}
            >
              Cancelar
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
