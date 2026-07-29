"use client";

import { useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type Aba = {
  /** Vai para a URL — mantenha curto e estável, é o que se compartilha. */
  id: string;
  rotulo: string;
  icone?: React.ReactNode;
  /** Número ao lado do rótulo, tipo "3" em Integrações. */
  contador?: number;
  /** Marca a aba que precisa de atenção sem obrigar a abrir. */
  alerta?: boolean;
  conteudo: React.ReactNode;
};

/**
 * Abas de página.
 *
 * O conteúdo chega **já renderizado no servidor** e é só escondido/mostrado
 * aqui: trocar de aba não refaz requisição nem perde o que estava digitado num
 * formulário de outra aba. O custo é ter todo o DOM montado, que nestas telas é
 * pequeno perto de recarregar tudo a cada clique.
 *
 * A aba escolhida vai para a URL por `history.replaceState`, e não pelo router:
 * o objetivo é poder compartilhar e recarregar no mesmo lugar, sem pagar uma
 * volta ao servidor a cada troca.
 */
export function Abas({
  itens,
  inicial,
  parametro = "aba",
  className,
}: {
  itens: Aba[];
  inicial?: string;
  parametro?: string;
  className?: string;
}) {
  const base = useId();
  const [ativa, setAtiva] = useState(
    () => itens.find((i) => i.id === inicial)?.id ?? itens[0]?.id,
  );
  const listaRef = useRef<HTMLDivElement>(null);

  function selecionar(id: string) {
    setAtiva(id);

    // Sem router.replace de propósito: em App Router ele reexecuta o componente
    // de servidor e a troca de aba deixaria de ser instantânea.
    const url = new URL(window.location.href);
    url.searchParams.set(parametro, id);
    window.history.replaceState(null, "", url);
  }

  /** Setas, Home e End — é o que se espera de uma lista de abas. */
  function navegarPeloTeclado(evento: React.KeyboardEvent) {
    const teclas = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!teclas.includes(evento.key)) return;
    evento.preventDefault();

    const atual = itens.findIndex((i) => i.id === ativa);
    const destino =
      evento.key === "Home"
        ? 0
        : evento.key === "End"
          ? itens.length - 1
          : evento.key === "ArrowRight"
            ? (atual + 1) % itens.length
            : (atual - 1 + itens.length) % itens.length;

    const id = itens[destino].id;
    selecionar(id);
    listaRef.current
      ?.querySelector<HTMLButtonElement>(`[data-aba="${id}"]`)
      ?.focus();
  }

  return (
    <div className={cn("space-y-5", className)}>
      <div
        ref={listaRef}
        role="tablist"
        aria-label="Seções da página"
        onKeyDown={navegarPeloTeclado}
        // Rola na horizontal no celular em vez de quebrar em duas linhas.
        className="-mx-1 flex gap-1 overflow-x-auto border-b border-line px-1"
      >
        {itens.map((item) => {
          const selecionada = item.id === ativa;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`${base}-aba-${item.id}`}
              data-aba={item.id}
              aria-selected={selecionada}
              aria-controls={`${base}-painel-${item.id}`}
              // Só a aba ativa entra na ordem de tabulação; dentro da lista
              // quem navega são as setas.
              tabIndex={selecionada ? 0 : -1}
              onClick={() => selecionar(item.id)}
              className={cn(
                "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                selecionada
                  ? "border-accent text-foreground"
                  : "border-transparent text-muted hover:border-line hover:text-foreground",
              )}
            >
              {item.icone}
              {item.rotulo}

              {typeof item.contador === "number" ? (
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] font-medium",
                    selecionada
                      ? "bg-accent/12 text-accent"
                      : "bg-foreground/[0.06] text-muted",
                  )}
                >
                  {item.contador}
                </span>
              ) : null}

              {item.alerta ? (
                <span
                  className="size-1.5 rounded-full bg-danger"
                  aria-label="requer atenção"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {itens.map((item) => (
        <div
          key={item.id}
          role="tabpanel"
          id={`${base}-painel-${item.id}`}
          aria-labelledby={`${base}-aba-${item.id}`}
          // `hidden` em vez de desmontar: preserva rascunho de formulário e o
          // que estiver aberto nas outras abas.
          hidden={item.id !== ativa}
          className="space-y-6"
        >
          {item.conteudo}
        </div>
      ))}
    </div>
  );
}
