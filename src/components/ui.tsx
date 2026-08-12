import * as React from "react";
import { cn } from "@/lib/utils";

/** Primitivas de UI do painel. Conjunto pequeno de propósito — cresce sob demanda. */

/** Anel de foco igual em tudo que é focável, inclusive nos links que viram botão. */
export const FOCO =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function Button({
  className,
  variant = "primary",
  size = "md",
  ...props
}: React.ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
}) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition",
        "disabled:pointer-events-none disabled:opacity-50",
        FOCO,
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-9 px-4 text-sm",
        variant === "primary" &&
          "bg-accent text-white shadow-sm hover:brightness-110 active:brightness-95",
        variant === "secondary" &&
          "border border-line bg-surface hover:border-accent/40 hover:bg-accent-soft",
        variant === "ghost" &&
          "text-muted hover:bg-accent-soft hover:text-foreground",
        variant === "danger" && "bg-danger text-white hover:brightness-110",
        className,
      )}
      {...props}
    />
  );
}

const campo =
  "w-full rounded-lg border border-line bg-surface text-sm transition " +
  "placeholder:text-muted/70 focus-visible:border-accent/50 " +
  "focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent/30 " +
  "disabled:opacity-60";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(campo, "h-9 px-3", className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(campo, "p-3 leading-relaxed", className)}
      {...props}
    />
  );
}

export function Select({
  className,
  ...props
}: React.ComponentProps<"select">) {
  return <select className={cn(campo, "h-9 px-2.5", className)} {...props} />;
}

/**
 * Rótulo + campo + uma linha embaixo.
 *
 * `hint` é ajuda; `erro` é recusa — e os dois **não** podem sair iguais. Eles
 * saíam: a mensagem de validação vinha por `hint` e era pintada no mesmo cinza
 * do texto de ajuda, enquanto o formulário anunciava "confira os campos
 * destacados" sem destacar nenhum. Quem errava a senha lia "Use pelo menos 10
 * caracteres" achando que era instrução, não motivo da falha.
 *
 * Com `erro` preenchido, a mensagem vem em vermelho e a borda do controle
 * acompanha — inclusive de `select` e `textarea`, por isso o seletor de
 * descendente em vez de uma classe no filho: `Field` não controla o que
 * recebe.
 */
export function Field({
  label,
  hint,
  erro,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  erro?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "block space-y-1.5",
        erro &&
          "[&_input]:border-danger [&_select]:border-danger [&_textarea]:border-danger",
      )}
    >
      <span className="text-[13px] font-medium">{label}</span>
      {children}

      {erro ? (
        <span
          // Anunciado por leitor de tela quando aparece depois do envio.
          role="alert"
          className="block text-xs leading-relaxed font-medium text-danger"
        >
          {erro}
        </span>
      ) : hint ? (
        <span className="block text-xs leading-relaxed text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-xl border border-line bg-surface p-5 shadow-[var(--shadow-card)]",
        className,
      )}
      {...props}
    />
  );
}

/** Título de bloco dentro de um Card, com ícone recessivo à esquerda. */
export function TituloDeBloco({
  icone,
  children,
  descricao,
  acoes,
}: {
  icone?: React.ReactNode;
  children: React.ReactNode;
  descricao?: React.ReactNode;
  acoes?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {icone ? <span className="text-muted">{icone}</span> : null}
          {children}
        </h2>
        {descricao ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            {descricao}
          </p>
        ) : null}
      </div>
      {acoes ? <div className="flex items-center gap-2">{acoes}</div> : null}
    </div>
  );
}

export function Badge({
  className,
  tone = "neutral",
  ...props
}: React.ComponentProps<"span"> & {
  tone?: "neutral" | "success" | "danger" | "accent" | "warning";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap",
        tone === "neutral" && "bg-foreground/[0.06] text-muted",
        tone === "success" && "bg-success/12 text-success",
        tone === "danger" && "bg-danger/12 text-danger",
        tone === "accent" && "bg-accent/12 text-accent",
        tone === "warning" && "bg-warning/15 text-warning",
        className,
      )}
      {...props}
    />
  );
}

/** Bolinha de status — mais legível que texto quando repetida numa lista. */
export function Ponto({ ligado }: { ligado: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        ligado ? "bg-success" : "bg-muted/40",
      )}
    />
  );
}

export function Aviso({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "danger" | "success" | "warning";
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        "rounded-lg border px-3 py-2 text-[13px] leading-relaxed",
        tone === "danger" && "border-danger/25 bg-danger/[0.06] text-danger",
        tone === "success" &&
          "border-success/25 bg-success/[0.06] text-success",
        tone === "warning" && "border-warning/30 bg-warning/[0.07] text-warning",
        tone === "neutral" && "border-line bg-foreground/[0.02] text-muted",
      )}
    >
      {children}
    </p>
  );
}

export function PageHeader({
  titulo,
  descricao,
  acoes,
  semBorda = false,
}: {
  titulo: string;
  descricao?: React.ReactNode;
  acoes?: React.ReactNode;
  /** Use quando vier uma tira de abas logo abaixo — ela já traz a linha, e as
   *  duas juntas viram duas réguas coladas. */
  semBorda?: boolean;
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-start justify-between gap-4",
        !semBorda && "border-b border-line pb-5",
      )}
    >
      <div className="space-y-1">
        <h1 className="text-[22px] font-semibold tracking-tight">{titulo}</h1>
        {descricao ? (
          <p className="max-w-2xl text-sm leading-relaxed text-muted">
            {descricao}
          </p>
        ) : null}
      </div>
      {acoes ? (
        <div className="flex flex-wrap items-center gap-2">{acoes}</div>
      ) : null}
    </header>
  );
}

export function EmptyState({
  icone,
  titulo,
  descricao,
  acao,
}: {
  icone?: React.ReactNode;
  titulo: string;
  descricao?: React.ReactNode;
  acao?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-14 text-center">
      {icone ? (
        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-lg bg-foreground/[0.04] text-muted">
          {icone}
        </div>
      ) : null}
      <p className="text-sm font-medium">{titulo}</p>
      {descricao ? (
        <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted">
          {descricao}
        </p>
      ) : null}
      {acao ? <div className="mt-4">{acao}</div> : null}
    </div>
  );
}

/** Rótulo curto para pares chave/valor em cabeçalhos e cartões. */
export function Meta({
  children,
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span className={cn("text-xs text-muted", className)} {...props}>
      {children}
    </span>
  );
}

/**
 * Ladrilho de número — um valor por vez, com rótulo em cima e uma linha de
 * contexto embaixo.
 *
 * É a forma certa para número solto: um gráfico de barra única não diz nada
 * além do que o número já diz, e ainda gasta espaço. O valor usa figuras
 * proporcionais de propósito — `tabular-nums` só vale em coluna que precisa
 * alinhar na vertical, e em tamanho grande deixa o número frouxo.
 */
export function Stat({
  rotulo,
  valor,
  detalhe,
  destaque = false,
  className,
}: {
  rotulo: string;
  valor: React.ReactNode;
  detalhe?: React.ReactNode;
  /** O número que a tela lidera. Um por vista. */
  destaque?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-line bg-surface p-4 shadow-[var(--shadow-card)]",
        className,
      )}
    >
      <p className="text-xs text-muted">{rotulo}</p>
      <p
        className={cn(
          "mt-1 font-semibold tracking-tight",
          destaque ? "text-[30px] leading-9" : "text-[19px] leading-7",
        )}
      >
        {valor}
      </p>
      {detalhe ? (
        <p className="mt-1 text-xs leading-relaxed text-muted">{detalhe}</p>
      ) : null}
    </div>
  );
}

/**
 * Barra de proporção para linha de tabela.
 *
 * Uma cor só para todas as linhas: a categoria aqui é nominal (modelo, agente),
 * e escurecer conforme o valor cresce só repetiria em cor o que o comprimento
 * já diz. O trilho é um passo da mesma superfície, não uma borda.
 */
export function Barra({
  fracao,
  titulo,
  className,
}: {
  /** 0 a 1. */
  fracao: number;
  titulo?: string;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fracao) ? fracao : 0));
  return (
    <span
      className={cn(
        "block h-1.5 w-full overflow-hidden rounded-full bg-surface-2",
        className,
      )}
      title={titulo}
      aria-hidden
    >
      {/* Largura mínima visível: 0,3% de um total grande sumiria por completo e
          a linha pareceria sem barra, e não com barra pequena. */}
      <span
        className="block h-full rounded-full bg-accent"
        style={{ width: pct > 0 ? `max(3px, ${(pct * 100).toFixed(2)}%)` : 0 }}
      />
    </span>
  );
}

/**
 * Tabela do painel. O `overflow-x` fica no invólucro: tabela larga rola dentro
 * do próprio cartão em vez de empurrar a página inteira na horizontal.
 */
export function Tabela({
  cabecalho,
  children,
  className,
}: {
  cabecalho: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-x-auto rounded-lg border border-line",
        className,
      )}
    >
      <table className="w-full border-collapse text-sm">
        <thead className="bg-surface-2 text-left">
          <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-xs [&>th]:font-medium [&>th]:whitespace-nowrap [&>th]:text-muted">
            {cabecalho}
          </tr>
        </thead>
        <tbody className="divide-y divide-line [&>tr>td]:px-3 [&>tr>td]:py-2">
          {children}
        </tbody>
      </table>
    </div>
  );
}
