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
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors",
        "disabled:pointer-events-none disabled:opacity-50",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        size === "sm" ? "h-8 px-3 text-sm" : "h-10 px-4 text-sm",
        variant === "primary" && "bg-accent text-white hover:opacity-90",
        variant === "secondary" &&
          "border border-line bg-surface hover:bg-accent-soft",
        variant === "ghost" && "hover:bg-accent-soft",
        variant === "danger" && "bg-danger text-white hover:opacity-90",
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-md border border-line bg-surface px-3 text-sm",
        "placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "w-full rounded-md border border-line bg-surface p-3 text-sm leading-relaxed",
        "placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent",
        className,
      )}
      {...props}
    />
  );
}

export function Select({
  className,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-10 w-full rounded-md border border-line bg-surface px-3 text-sm",
        "focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent",
        className,
      )}
      {...props}
    />
  );
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
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Card({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-lg border border-line bg-surface p-5",
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
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "neutral" && "bg-accent-soft/60 text-muted",
        tone === "success" && "bg-success/10 text-success",
        tone === "danger" && "bg-danger/10 text-danger",
        tone === "accent" && "bg-accent-soft text-accent",
        className,
      )}
      {...props}
    />
  );
}

export function Aviso({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "danger";
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        tone === "danger"
          ? "border-danger/30 bg-danger/5 text-danger"
          : "border-line bg-accent-soft/40 text-muted",
      )}
    >
      {children}
    </p>
  );
}
