import * as React from "react";
import { cn } from "@/lib/utils";

/** Primitivas de UI do painel. Conjunto pequeno de propósito — cresce sob demanda. */

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
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-9 px-4 text-sm",
        variant === "primary" &&
          "bg-accent text-white shadow-sm hover:brightness-110 active:brightness-95",
        variant === "secondary" &&
          "border border-line bg-surface hover:border-accent/40 hover:bg-accent-soft",
        variant === "ghost" && "text-muted hover:bg-accent-soft hover:text-foreground",
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
    <textarea className={cn(campo, "p-3 leading-relaxed", className)} {...props} />
  );
}

export function Select({ className, ...props }: React.ComponentProps<"select">) {
  return <select className={cn(campo, "h-9 px-2.5", className)} {...props} />;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[13px] font-medium">{label}</span>
      {children}
      {hint ? (
        <span className="block text-xs leading-relaxed text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]",
        className,
      )}
      {...props}
    />
  );
}

export function Badge({
  className,
  tone = "neutral",
  ...props
}: React.ComponentProps<"span"> & {
  tone?: "neutral" | "success" | "danger" | "accent";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap",
        tone === "neutral" && "bg-foreground/[0.06] text-muted",
        tone === "success" && "bg-success/12 text-success",
        tone === "danger" && "bg-danger/12 text-danger",
        tone === "accent" && "bg-accent/12 text-accent",
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
  tone?: "neutral" | "danger" | "success";
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        "rounded-lg border px-3 py-2 text-[13px] leading-relaxed",
        tone === "danger" && "border-danger/25 bg-danger/[0.06] text-danger",
        tone === "success" && "border-success/25 bg-success/[0.06] text-success",
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
}: {
  titulo: string;
  descricao?: React.ReactNode;
  acoes?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
      <div className="space-y-1">
        <h1 className="text-[22px] font-semibold tracking-tight">{titulo}</h1>
        {descricao ? (
          <p className="max-w-2xl text-sm leading-relaxed text-muted">
            {descricao}
          </p>
        ) : null}
      </div>
      {acoes ? <div className="flex items-center gap-2">{acoes}</div> : null}
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
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("text-xs text-muted", className)}>{children}</span>
  );
}
