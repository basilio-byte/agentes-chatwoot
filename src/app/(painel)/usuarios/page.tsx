import { db } from "@/lib/db";
import { exigirSessao } from "@/server/auth-guard";
import { UserRole } from "@/generated/prisma/enums";
import { GestaoDeUsuarios, TrocarMinhaSenha } from "@/components/usuarios";
import { Aviso, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function UsuariosPage() {
  const sessao = await exigirSessao();
  const souOwner = sessao.user.role === UserRole.OWNER;

  const usuarios = await db.user.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      createdAt: true,
      _count: { select: { agentesQuePossui: true } },
    },
  });

  return (
    <>
      <PageHeader
        titulo="Usuários"
        descricao="Quem tem acesso ao painel. O papel define o que cada um pode fazer — e é o que aparece como dono nos agentes."
      />

      {!souOwner ? (
        <Aviso>
          Você está vendo a lista em modo leitura. Criar contas, mudar papel e
          redefinir senha é coisa de proprietário.
        </Aviso>
      ) : null}

      <GestaoDeUsuarios
        meuId={sessao.user.id}
        souOwner={souOwner}
        usuarios={usuarios.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          active: u.active,
          createdAt: u.createdAt,
          agentes: u._count.agentesQuePossui,
        }))}
      />

      <TrocarMinhaSenha />
    </>
  );
}
