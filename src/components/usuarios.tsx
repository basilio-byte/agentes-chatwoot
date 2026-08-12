"use client";

import { useActionState, useState, useTransition } from "react";
import { Check, KeyRound, UserPlus, X } from "lucide-react";
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
import { ORDEM_DOS_PAPEIS, PAPEIS } from "@/lib/papeis";
import { formatarData } from "@/lib/utils";

/**
 * O que o papel escolhido concede e o que ele nega, lado a lado.
 *
 * A lista do que **não** pode é tão importante quanto a do que pode: quem
 * libera acesso precisa saber o que está segurando, e uma frase de resumo não
 * cabe isso.
 */
function DetalheDoPapel({ papel }: { papel: UserRole }) {
  const { pode, naoPode } = PAPEIS[papel];

  return (
    <div className="grid gap-3 rounded-lg border border-line bg-surface-2 p-3 text-xs leading-relaxed sm:grid-cols-2">
      <div className="space-y-1">
        <p className="font-medium text-success">Pode</p>
        <ul className="space-y-0.5 text-muted">
          {pode.map((item) => (
            <li key={item} className="flex gap-1.5">
              <Check size={12} aria-hidden className="mt-0.5 shrink-0 text-success" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-1">
        <p className="font-medium text-muted">Não pode</p>
        <ul className="space-y-0.5 text-muted">
          {naoPode.map((item) => (
            <li key={item} className="flex gap-1.5">
              <X size={12} aria-hidden className="mt-0.5 shrink-0 text-muted/70" />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Opções do seletor, da menor para a maior permissão. */
function OpcoesDePapel() {
  return (
    <>
      {ORDEM_DOS_PAPEIS.map((papel) => (
        <option key={papel} value={papel}>
          {PAPEIS[papel].rotulo}
        </option>
      ))}
    </>
  );
}

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
  // O papel escolhido é estado da tela porque a descrição embaixo do seletor
  // precisa acompanhá-lo. Antes a dica era fixa na do Administrador, então
  // "Leitura" e "Proprietário" apareciam descritos como se fossem admin — e é
  // por essa frase que alguém decide o que está entregando.
  const [papelNovo, setPapelNovo] = useState<UserRole>(UserRole.ADMIN);
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
              <Field label="Nome" erro={estadoNovo.camposComErro?.name}>
                <Input name="name" required autoFocus />
              </Field>
              <Field label="E-mail" erro={estadoNovo.camposComErro?.email}>
                <Input name="email" type="email" required />
              </Field>
              <Field
                label="Senha inicial"
                hint="Mínimo de 10 caracteres."
                erro={estadoNovo.camposComErro?.password}
              >
                <Input
                  name="password"
                  type="password"
                  required
                  minLength={10}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Papel" hint={PAPEIS[papelNovo].resumo}>
                <Select
                  name="role"
                  value={papelNovo}
                  onChange={(e) => setPapelNovo(e.target.value as UserRole)}
                >
                  <OpcoesDePapel />
                </Select>
              </Field>
            </div>

            <DetalheDoPapel papel={papelNovo} />

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
                  {/* `title` com o resumo do papel atual: aqui não há espaço
                      para a descrição, e sem ela o seletor é só um rótulo. */}
                  <Select
                    className="h-8 w-auto text-[13px]"
                    aria-label={`Papel de ${u.name}`}
                    title={PAPEIS[u.role].resumo}
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
                    <OpcoesDePapel />
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
                <Badge title={PAPEIS[u.role].resumo}>
                  {PAPEIS[u.role].rotulo}
                </Badge>
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
        <Field
          label="Nova senha"
          hint="Mínimo de 10 caracteres."
          erro={estado.camposComErro?.password}
        >
          <Input
            name="password"
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
          />
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
        <Field label="Senha atual" erro={estado.camposComErro?.atual}>
          <Input name="atual" type="password" required autoComplete="current-password" />
        </Field>
        <Field
          label="Nova senha"
          hint="Mínimo de 10 caracteres."
          erro={estado.camposComErro?.nova}
        >
          <Input
            name="nova"
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
          />
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
