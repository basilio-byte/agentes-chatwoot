"use client";

import { useActionState } from "react";
import Image from "next/image";
import { entrar, type EstadoLogin } from "@/server/actions/auth";
import { Aviso, Button, Card, Field, Input } from "@/components/ui";

export function FormularioLogin() {
  const [estado, acao, pendente] = useActionState<EstadoLogin, FormData>(
    entrar,
    {},
  );

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
      {/* Duas manchas largas e muito fracas na cor da marca. É o que tira a
          tela de login do branco liso sem pôr nada para a pessoa ler: o cartão
          fica sobre alguma coisa, em vez de flutuar no vazio. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-[15%] left-1/2 size-[640px] -translate-x-1/2 rounded-full bg-accent/[0.07] blur-3xl" />
        <div className="absolute -bottom-[20%] left-[12%] size-[420px] rounded-full bg-accent/[0.05] blur-3xl" />
      </div>

      <div className="w-full max-w-[380px]">
      <Card className="space-y-6 p-7 shadow-[var(--shadow-flutuante)]">
        <header className="space-y-4">
          <Image
            src="/seahub-logo.png"
            alt="Seahub"
            width={104}
            height={36}
            className="logo-seahub h-7 w-auto"
            priority
          />
          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">
              Agentes de atendimento
            </h1>
            <p className="text-sm leading-relaxed text-muted">
              Entre para gerenciar os agentes que atendem no WhatsApp.
            </p>
          </div>
        </header>

        <form action={acao} className="space-y-4">
          <Field label="E-mail">
            <Input
              name="email"
              type="email"
              required
              autoComplete="email"
              autoFocus
            />
          </Field>

          <Field label="Senha">
            <Input
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          </Field>

          {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}

          <Button type="submit" className="w-full" disabled={pendente}>
            {pendente ? "Entrando…" : "Entrar"}
          </Button>
        </form>
      </Card>

        <p className="mt-5 text-center text-xs text-muted">
          Seahub Coworking · painel interno
        </p>
      </div>
    </main>
  );
}
