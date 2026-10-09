"use client";

import { useState, useTransition } from "react";
import { RotateCcw } from "lucide-react";
import { tentarEmitirDeNovo, type EstadoNotasFiscais } from "@/server/actions/notas-fiscais";
import { Button } from "@/components/ui";

/**
 * "Tentar de novo" numa nota rejeitada ou parada. Pede confirmação porque o que
 * sai daqui é nota fiscal: só depois de a causa estar corrigida. O estado local
 * some no reload, de propósito — a lista é que diz a situação da nota.
 */
export function BotaoTentarDeNovo({ chave }: { chave: string }) {
  const [resposta, setResposta] = useState<EstadoNotasFiscais | null>(null);
  const [ocupado, iniciar] = useTransition();

  function tentar() {
    if (
      !window.confirm(
        "Reenviar esta nota à prefeitura? Faça isso só depois de corrigir a causa. É a mesma nota: não gasta outro número.",
      )
    ) {
      return;
    }
    iniciar(async () => {
      setResposta(await tentarEmitirDeNovo(chave));
    });
  }

  return (
    <div className="space-y-1">
      <Button type="button" variant="secondary" size="sm" disabled={ocupado || !!resposta?.ok} onClick={tentar}>
        <RotateCcw size={14} aria-hidden />
        {ocupado ? "Liberando…" : "Tentar de novo"}
      </Button>
      {resposta?.ok ? <p className="max-w-xs text-xs text-muted">{resposta.ok}</p> : null}
      {resposta?.erro ? <p className="max-w-xs text-xs text-danger">{resposta.erro}</p> : null}
    </div>
  );
}
