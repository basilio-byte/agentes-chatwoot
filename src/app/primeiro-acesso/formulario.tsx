"use client";

import { useActionState } from "react";
import {
  criarPrimeiroUsuario,
  type EstadoBootstrap,
} from "@/server/actions/bootstrap";
import { Aviso, Button, Card, Field, Input } from "@/components/ui";

export function FormularioPrimeiroAcesso({
  exigeToken,
}: {
  exigeToken: boolean;
}) {
  const [estado, acao, pendente] = useActionState<EstadoBootstrap, FormData>(
    criarPrimeiroUsuario,
    {},
  );
  const erroDe = (campo: string) => estado.camposComErro?.[campo];

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm space-y-5">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold">Primeiro acesso</h1>
          <p className="text-sm text-muted">
            Nenhuma conta existe ainda. Crie a conta de administrador — esta tela
            desaparece depois.
          </p>
        </header>

        <form action={acao} className="space-y-4">
          <Field label="Nome" hint={erroDe("name")}>
            <Input name="name" required autoFocus autoComplete="name" />
          </Field>

          <Field label="E-mail" hint={erroDe("email")}>
            <Input name="email" type="email" required autoComplete="email" />
          </Field>

          <Field
            label="Senha"
            hint={erroDe("password") ?? "Mínimo de 10 caracteres."}
          >
            <Input
              name="password"
              type="password"
              required
              autoComplete="new-password"
            />
          </Field>

          {exigeToken ? (
            <Field
              label="Token de instalação"
              hint={erroDe("token") ?? "Valor de BOOTSTRAP_TOKEN."}
            >
              <Input name="token" required />
            </Field>
          ) : null}

          {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}

          <Button type="submit" className="w-full" disabled={pendente}>
            {pendente ? "Criando…" : "Criar conta e entrar"}
          </Button>
        </form>
      </Card>
    </main>
  );
}
