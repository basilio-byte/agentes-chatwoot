"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
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

  /**
   * De que lado ainda há aba fora da vista.
   *
   * ⚠ Existe porque `sem-barra` esconde a barra de rolagem: a tira rola, mas
   * não havia **nada** dizendo isso. Enquanto nenhuma página passava de seis
   * abas ninguém notou; na sétima, a última some da tela e parece não existir.
   * Foi o que aconteceu em Integrações — "Leitura de mídia" desapareceu atrás
   * da borda, e ela é justamente o pré-requisito da integração que entrou na
   * frente dela.
   */
  const [sobra, setSobra] = useState({ esquerda: false, direita: false });

  const conferirSobra = useCallback(() => {
    const el = listaRef.current;
    if (!el) return;
    // A folga de 2px absorve arredondamento de zoom e de tela HiDPI, que senão
    // deixa a sombra acesa numa tira que já chegou ao fim.
    const folga = el.scrollWidth - el.clientWidth;
    setSobra({
      esquerda: el.scrollLeft > 2,
      direita: folga > 2 && el.scrollLeft < folga - 2,
    });
  }, []);

  useEffect(() => {
    const el = listaRef.current;
    if (!el) return;

    conferirSobra();

    const observador = new ResizeObserver(conferirSobra);
    observador.observe(el);
    // Os filhos também: a tira não muda de tamanho quando a FONTE termina de
    // carregar, mas o conteúdo dela muda — e é aí que a sobra aparece.
    for (const filho of el.children) observador.observe(filho);

    return () => observador.disconnect();
  }, [conferirSobra, itens.length]);

  // A aba escolhida pela URL pode estar fora da vista, e aí a página abre com
  // um painel visível cuja aba não aparece em lugar nenhum. Só na montagem:
  // depois disso, quem rola é quem clica.
  useEffect(() => {
    listaRef.current
      ?.querySelector<HTMLButtonElement>(`[data-aba="${ativa}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      {/* A moldura existe só para pendurar as sombras de rolagem. */}
      <div className="relative">
        <div
          ref={listaRef}
          role="tablist"
          aria-label="Seções da página"
          onKeyDown={navegarPeloTeclado}
          onScroll={conferirSobra}
          // Rola na horizontal em tela estreita em vez de quebrar em duas
          // linhas. `sem-barra` esconde o scrollbar: o clássico do Windows
          // aparecia como uma faixa cinza sob as abas e fazia a tira parecer
          // quebrada. Quem avisa que há mais são as sombras abaixo.
          className="sem-barra flex gap-1 overflow-x-auto border-b border-line"
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
                  "-mb-px flex shrink-0 items-center gap-2 rounded-t-lg border-b-2 px-3.5 py-3 text-sm whitespace-nowrap transition-colors",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                  selecionada
                    ? "border-accent font-medium text-foreground"
                    : "border-transparent text-muted hover:bg-foreground/[0.03] hover:text-foreground",
                )}
              >
                <span className={selecionada ? "text-accent" : "text-muted/70"}>
                  {item.icone}
                </span>
                {item.rotulo}

                {/* Zero não informa nada — só polui a tira. */}
                {item.contador ? (
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
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
                    title="Precisa de configuração"
                    className="size-1.5 shrink-0 rounded-full bg-danger"
                    aria-label="precisa de configuração"
                  />
                ) : null}
              </button>
            );
          })}
        </div>

        {/*
          Sombra em degradê nas pontas — o único sinal de que a tira continua.
          `pointer-events-none` para não roubar o clique da aba que está
          embaixo, e `bottom-px` para não cobrir a linha que separa a tira do
          conteúdo. A cor sai de `--background`, então funciona nos dois temas
          sem uma segunda definição.
        */}
        {sobra.esquerda ? (
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-px left-0 w-8 bg-linear-to-r from-background to-transparent"
          />
        ) : null}
        {sobra.direita ? (
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 right-0 bottom-px w-8 bg-linear-to-l from-background to-transparent"
          />
        ) : null}
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
