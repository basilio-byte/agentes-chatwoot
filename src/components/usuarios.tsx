"use client";

import { useActionState, useState, useTransition } from "react";
import { KeyRound, UserPlus } from "lucide-react";
import { UserRole } from "@/generated/prisma/enums";
import {
  alterarPapel,
  alternarAtivoUsuario,
  criarUsuario,
  redefinirSenha,
  trocarMinhaSenha,
  type EstadoUsuario,
} from "@/server/actions/usuarios";
import {
  Aviso,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Meta,
  Ponto,
  Select,
} from "@/components/ui";
import { formatarData } from "@/lib/utils";

export const PAPEIS: Record<UserRole, string> = {
  OWNER: "Proprietário",
  ADMIN: "Administrador",
  VIEWER: "Leitura",
};

const DESCRICAO_PAPEL: Record<UserRole, string> = {
  OWNER: "Faz tudo, incluindo credenciais e contas.",
  ADMIN: "Cria e edita agentes; não mexe em credenciais.",
  VIEWER: "Só visualiza.",
};

export type UsuarioDaLista = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  createdAt: Date | string;
  agentes: number;
};

export function GestaoDeUsuarios({
  usuarios,
  meuId,
  souOwner,
}: {
  usuarios: UsuarioDaLista[];
  meuId: string;
  souOwner: boolean;
}) {
  const [criando, setCriando] = useState(false);
  const [estadoNovo, acaoNova, salvandoNovo] = useActionState<
    EstadoUsuario,
    FormData
  >(criarUsuario, {});
  const [resultado, setResultado] = useState<EstadoUsuario | null>(null);
  const [ocupado, iniciar] = useTransition();
  const [redefinindo, setRedefinindo] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {souOwner ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setCriando((v) => !v)}>
            <UserPlus size={14} aria-hidden />
            {criando ? "Cancelar" : "Nova conta"}
          </Button>
        </div>
      ) : null}

      {criando ? (
        <Card>
          <form action={acaoNova} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nome" hint={estadoNovo.camposComErro?.name}>
                <Input name="name" required autoFocus />
              </Field>
              <Field label="E-mail" hint={estadoNovo.camposComErro?.email}>
                <Input name="email" type="email" required />
              </Field>
              <Field
                label="Senha inicial"
                hint={
                  estadoNovo.camposComErro?.password ?? "Mínimo de 10 caracteres."
                }
              >
                <Input name="password" type="password" required />
              </Field>
              <Field label="Papel" hint={DESCRICAO_PAPEL.ADMIN}>
                <Select name="role" defaultValue={UserRole.ADMIN}>
                  {Object.entries(PAPEIS).map(([valor, rotulo]) => (
                    <option key={valor} value={valor}>
                      {rotulo}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {estadoNovo.erro ? <Aviso tone="danger">{estadoNovo.erro}</Aviso> : null}
            {estadoNovo.ok ? <Aviso tone="success">{estadoNovo.ok}</Aviso> : null}

            <Button type="submit" disabled={salvandoNovo}>
              {salvandoNovo ? "Criando…" : "Criar conta"}
            </Button>
          </form>
        </Card>
      ) : null}

      {resultado?.erro ? <Aviso tone="danger">{resultado.erro}</Aviso> : null}
      {resultado?.ok ? <Aviso tone="success">{resultado.ok}</Aviso> : null}

      <div className="space-y-2">
        {usuarios.map((u) => (
          <Card key={u.id} className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Ponto ligado={u.active} />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{u.name}</span>
                  {u.id === meuId ? <Badge tone="accent">você</Badge> : null}
                  {!u.active ? <Badge tone="danger">desativada</Badge> : null}
                </div>
                <Meta className="block truncate">{u.email}</Meta>
              </div>

              <Meta>
                {u.agentes} agente(s) · desde {formatarData(u.createdAt)}
              </Meta>

              {souOwner ? (
                <div className="flex items-center gap-2">
                  <Select
                    className="h-8 w-auto text-[13px]"
                    value={u.role}
                    disabled={ocupado}
                    onChange={(e) =>
                      iniciar(async () =>
                        setResultado(
                          await alterarPapel(u.id, e.target.value as UserRole),
                        ),
                      )
                    }
                  >
                    {Object.entries(PAPEIS).map(([valor, rotulo]) => (
                      <option key={valor} value={valor}>
                        {rotulo}
                      </option>
                    ))}
                  </Select>

                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={ocupado}
                    onClick={() =>
                      setRedefinindo(redefinindo === u.id ? null : u.id)
                    }
                    title="Redefinir senha"
                  >
                    <KeyRound size={14} aria-hidden />
                  </Button>

                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={ocupado || u.id === meuId}
                    onClick={() =>
                      iniciar(async () =>
                        setResultado(await alternarAtivoUsuario(u.id)),
                      )
                    }
                  >
                    {u.active ? "Desativar" : "Reativar"}
                  </Button>
                </div>
              ) : (
                <Badge>{PAPEIS[u.role]}</Badge>
              )}
            </div>

            {redefinindo === u.id ? (
              <RedefinirSenha
                userId={u.id}
                onPronto={(r) => {
                  setResultado(r);
                  setRedefinindo(null);
                }}
              />
            ) : null}
          </Card>
        ))}
      </div>
    </div>
  );
}

function RedefinirSenha({
  userId,
  onPronto,
}: {
  userId: string;
  onPronto: (r: EstadoUsuario) => void;
}) {
  const [estado, acao, salvando] = useActionState<EstadoUsuario, FormData>(
    async (prev, formData) => {
      const r = await redefinirSenha(userId, prev, formData);
      if (r.ok) onPronto(r);
      return r;
    },
    {},
  );

  return (
    <form action={acao} className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
      <div className="min-w-56 flex-1">
        <Field label="Nova senha" hint={estado.camposComErro?.password}>
          <Input name="password" type="password" required />
        </Field>
      </div>
      <Button type="submit" size="sm" disabled={salvando}>
        {salvando ? "Salvando…" : "Redefinir"}
      </Button>
      {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
    </form>
  );
}

export function TrocarMinhaSenha() {
  const [estado, acao, salvando] = useActionState<EstadoUsuario, FormData>(
    trocarMinhaSenha,
    {},
  );

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Minha senha</h2>
        <p className="text-xs text-muted">Vale para qualquer papel.</p>
      </div>

      <form action={acao} className="grid gap-4 sm:grid-cols-2">
        <Field label="Senha atual" hint={estado.camposComErro?.atual}>
          <Input name="atual" type="password" required autoComplete="current-password" />
        </Field>
        <Field
          label="Nova senha"
          hint={estado.camposComErro?.nova ?? "Mínimo de 10 caracteres."}
        >
          <Input name="nova" type="password" required autoComplete="new-password" />
        </Field>

        <div className="sm:col-span-2">
          {estado.erro ? <Aviso tone="danger">{estado.erro}</Aviso> : null}
          {estado.ok ? <Aviso tone="success">{estado.ok}</Aviso> : null}
        </div>

        <div className="sm:col-span-2">
          <Button type="submit" disabled={salvando}>
            {salvando ? "Salvando…" : "Alterar senha"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
