"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, RotateCcw } from "lucide-react";
import {
  reabrirLacuna,
  resolverLacuna,
  type EstadoDaLacuna,
} from "@/server/actions/lacunas";
import { Button, Textarea } from "@/components/ui";

/** O teto do comentário, o mesmo que o servidor confere (`TETO_DA_RESOLUCAO`). */
const TETO = 1000;

/**
 * Resolve uma lacuna: pede o que foi feito e a manda para o Histórico.
 *
 * O comentário é obrigatório e fica na linha — é o que quem abre o Histórico
 * depois vai ler. O botão só aparece para Administrador (a página decide), mas
 * quem confere de verdade é a ação do servidor.
 *
 * A resposta de erro fica no formulário, que continua aberto com o texto que a
 * pessoa já escreveu: perder o comentário por uma recusa seria o pior jeito de
 * dizer "tente de novo".
 */
export function ResolverLacuna({ id }: { id: string }) {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [texto, setTexto] = useState("");
  const [resposta, setResposta] = useState<EstadoDaLacuna | null>(null);
  const [ocupado, iniciar] = useTransition();

  function resolver() {
    iniciar(async () => {
      const resultado = await resolverLacuna(id, texto);
      setResposta(resultado);
      if (resultado.ok) router.refresh();
    });
  }

  if (!aberto) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setAberto(true)}
      >
        <CheckCircle2 size={14} aria-hidden />
        Resolver
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3">
      <label className="block space-y-1">
        <span className="text-xs font-medium">O que foi feito para resolver?</span>
        <Textarea
          rows={3}
          maxLength={TETO}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder="Ex.: acrescentei ao prompt o procedimento de segunda via; testado no playground."
          autoFocus
          disabled={ocupado}
        />
      </label>
      <p className="text-[11px] text-muted">
        Esse comentário fica no Histórico, com a data de hoje e o seu nome. Sem dado
        pessoal de cliente. {texto.length}/{TETO}
      </p>

      {resposta?.erro ? <p className="text-xs text-danger">{resposta.erro}</p> : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={resolver} disabled={ocupado}>
          <CheckCircle2 size={14} aria-hidden />
          {ocupado ? "Resolvendo…" : "Marcar como resolvida"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setAberto(false);
            setResposta(null);
          }}
          disabled={ocupado}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
}

/**
 * Devolve uma lacuna do Histórico para a fila. A exclusão saiu da tela, então
 * resolver por engano precisa ter volta; o comentário anterior vai para a
 * auditoria, não se perde.
 */
export function ReabrirLacuna({ id }: { id: string }) {
  const router = useRouter();
  const [resposta, setResposta] = useState<EstadoDaLacuna | null>(null);
  const [ocupado, iniciar] = useTransition();

  function reabrir() {
    if (
      !window.confirm(
        "Reabrir esta lacuna? Ela volta para a fila de abertas e o comentário da resolução sai da linha (fica só na auditoria).",
      )
    ) {
      return;
    }
    iniciar(async () => {
      const resultado = await reabrirLacuna(id);
      setResposta(resultado);
      if (resultado.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={reabrir}
        disabled={ocupado}
      >
        <RotateCcw size={14} aria-hidden />
        {ocupado ? "Reabrindo…" : "Reabrir"}
      </Button>
      {resposta?.erro ? (
        <p className="max-w-xs text-xs text-danger">{resposta.erro}</p>
      ) : null}
    </div>
  );
}
