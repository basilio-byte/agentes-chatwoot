"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { apagarLacunas, type EstadoDaLacuna } from "@/server/actions/lacunas";
import { Button } from "@/components/ui";

/**
 * Apaga uma ou várias lacunas já tratadas. Pede confirmação: some da vista da
 * equipe inteira, e não há como desfazer.
 *
 * Manda os IDS da tela, não um filtro — o que a pessoa viu é o que sai. A
 * resposta fica ao lado do botão e some no recarregamento, que é o que o
 * `router.refresh()` provoca: a lista é que diz o que sobrou.
 */
export function BotaoApagarLacunas({
  ids,
  rotulo,
  confirmacao,
  tamanho = "sm",
}: {
  ids: string[];
  rotulo: string;
  confirmacao: string;
  tamanho?: "sm" | "md";
}) {
  const router = useRouter();
  const [resposta, setResposta] = useState<EstadoDaLacuna | null>(null);
  const [ocupado, iniciar] = useTransition();

  function apagar() {
    if (!window.confirm(confirmacao)) return;
    iniciar(async () => {
      const resultado = await apagarLacunas(ids);
      setResposta(resultado);
      if (resultado.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="secondary"
        size={tamanho}
        disabled={ocupado || ids.length === 0}
        onClick={apagar}
      >
        <Trash2 size={14} aria-hidden />
        {ocupado ? "Apagando…" : rotulo}
      </Button>
      {resposta?.erro ? (
        <p className="max-w-xs text-xs text-danger">{resposta.erro}</p>
      ) : null}
    </div>
  );
}
