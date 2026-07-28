"use client";

import { useActionState } from "react";
import { entrar, type EstadoLogin } from "@/server/actions/auth";
import { Aviso, Button, Card, Field, Input } from "@/components/ui";

export function FormularioLogin() {
  const [estado, acao, pendente] = useActionState<EstadoLogin, FormData>(
    entrar,
    {},
  );

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm space-y-5">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold">Seahub Agentes</h1>
          <p className="text-sm text-muted">
            Entre para gerenciar os agentes de atendimento.
          </p>
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
    </main>
  );
}
