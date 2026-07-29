"use client";

import { useState, useTransition } from "react";
import { DoorOpen } from "lucide-react";
import { definirAgenteDeEntrada } from "@/server/actions/agents";
import { Badge, Button } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Marca um agente como o de entrada, direto na listagem.
 *
 * Comporta-se como rádio, não como interruptor: só existe um agente de entrada,
 * então não há "desmarcar" — o que existe é escolher outro. Um botão de
 * desligar aqui deixaria o painel sem entrada nenhuma, e aí quem atenderia
 * primeiro voltaria a ser arbitrário.
 */
export function SeletorDeEntrada({
  agenteId,
  ehEntrada,
}: {
  agenteId: string;
  ehEntrada: boolean;
}) {
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, iniciar] = useTransition();

  if (ehEntrada) {
    return (
      <Badge tone="accent" title="Recebe a primeira mensagem e distribui">
        <DoorOpen size={12} aria-hidden />
        entrada
      </Badge>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      title="Tornar este o agente que recebe a primeira mensagem"
      disabled={ocupado}
      className={cn("text-xs", aviso && "text-danger")}
      onClick={() =>
        iniciar(async () => {
          const r = await definirAgenteDeEntrada(agenteId);
          setAviso(r?.aviso ?? null);
        })
      }
    >
      <DoorOpen size={13} aria-hidden />
      {ocupado ? "definindo…" : "definir como entrada"}
    </Button>
  );
}
