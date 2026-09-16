"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Bloco que abre e fecha, com o cabeçalho sempre legível.
 *
 * Existe porque a aba Gatilhos empilhava quatro maneiras de acionar o agente,
 * cada uma com formulário, exemplo da mensagem e histórico de entregas: dez
 * blocos do mesmo tamanho, quase quatro mil pixels de altura, e nada dizendo
 * quais estavam ligadas. Fechado, cada porta ocupa uma linha e diz o que
 * dispara e em que estado está — que é a pergunta de quem abre a aba.
 *
 * ⚠ **O estado aberto/fechado é do navegador, não da prop.** A prop só decide
 * como o bloco NASCE. Se ela mandasse sempre, salvar o formulário de um gatilho
 * desligado o fecharia na cara de quem salvou, escondendo o próprio aviso de
 * "salvo" — as server actions revalidam e o componente volta a renderizar.
 */
export function Recolhivel({
  titulo,
  icone,
  estado,
  acao,
  resumo,
  padraoAberto = false,
  children,
  className,
}: {
  titulo: string;
  icone?: React.ReactNode;
  /** Badge de ligado/desligado. Fica ao lado do título, aberto ou fechado. */
  estado?: React.ReactNode;
  /**
   * Botão da linha — ligar/desligar sem precisar abrir.
   *
   * ⚠ Vive DENTRO do `<summary>`, então o clique dele chegaria ao cabeçalho e
   * abriria o bloco por tabela. O invólucro abaixo corta isso.
   */
  acao?: React.ReactNode;
  /** Uma linha dizendo o que dispara. Some quando o bloco abre: lá dentro vem a explicação inteira. */
  resumo?: React.ReactNode;
  padraoAberto?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [aberto, setAberto] = useState(padraoAberto);

  return (
    <details
      open={aberto}
      onToggle={(e) => setAberto((e.currentTarget as HTMLDetailsElement).open)}
      className={cn(
        "group rounded-xl border border-line bg-surface transition",
        aberto ? "shadow-[var(--shadow-card)]" : "hover:border-accent/40",
        className,
      )}
    >
      <summary
        className={cn(
          // `list-none` + `[&::-webkit-details-marker]:hidden`: o triângulo
          // nativo não acompanha o resto da interface, e o lugar dele é do
          // chevron, que gira.
          "flex cursor-pointer list-none items-center gap-2 px-4 py-3",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        {icone ? <span className="shrink-0 text-muted">{icone}</span> : null}
        <span className="shrink-0 text-sm font-semibold">{titulo}</span>
        {estado}

        <span className="ml-auto flex min-w-0 items-center gap-2">
          {resumo ? (
            // `max-sm:hidden` e `group-open:hidden` são a mesma propriedade, então
            // não brigam. `sm:block` brigaria: na ordem do Tailwind a variante
            // responsiva vence a de estado, e o resumo continuaria visível com o
            // bloco aberto.
            <span className="min-w-0 truncate text-xs text-muted max-sm:hidden group-open:hidden">
              {resumo}
            </span>
          ) : null}
          {acao ? (
            <span
              className="shrink-0"
              onClick={(e) => {
                // `preventDefault` é o que segura: o `<details>` abre como ação
                // padrão do clique no `<summary>`, e o clique do botão borbulha
                // até lá. Sem isto, ligar um gatilho abriria o bloco junto.
                e.stopPropagation();
                e.preventDefault();
              }}
            >
              {acao}
            </span>
          ) : null}
          <ChevronDown
            size={14}
            aria-hidden
            className="shrink-0 text-muted transition group-open:rotate-180"
          />
        </span>
      </summary>

      <div className="space-y-4 border-t border-line px-4 py-4">{children}</div>
    </details>
  );
}

/**
 * Recolhível de dentro de outro, para o que é referência e não configuração:
 * o formato da mensagem que o agente recebe, o histórico de entregas.
 *
 * Sem moldura própria — moldura dentro de moldura dentro de cartão vira
 * escadinha, e estes blocos são justamente os que ninguém precisa ver toda vez.
 */
export function RecolhivelInterno({
  titulo,
  contador,
  children,
}: {
  titulo: string;
  /** Aparece ao lado do título: dá para saber se vale abrir sem abrir. */
  contador?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <details className="group/interno border-t border-line pt-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-muted transition hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <ChevronDown
          size={13}
          aria-hidden
          className="transition group-open/interno:rotate-180"
        />
        {titulo}
        {contador != null ? (
          <span className="text-muted">({contador})</span>
        ) : null}
      </summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  );
}
