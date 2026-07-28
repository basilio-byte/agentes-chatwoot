import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { UserRole } from "@/generated/prisma/enums";

/** Sessão obrigatória. Uso em páginas e server actions. */
export async function exigirSessao() {
  const sessao = await auth();
  if (!sessao?.user) redirect("/login");
  return sessao;
}

/**
 * Sessão + papel. Hierarquia: OWNER > ADMIN > VIEWER.
 * OWNER é o único que mexe em credenciais de integração.
 */
const PESO: Record<UserRole, number> = {
  [UserRole.VIEWER]: 0,
  [UserRole.ADMIN]: 1,
  [UserRole.OWNER]: 2,
};

export async function exigirPapel(minimo: UserRole) {
  const sessao = await exigirSessao();
  if (PESO[sessao.user.role] < PESO[minimo]) {
    throw new Error("Sem permissão para esta ação.");
  }
  return sessao;
}

export function podeEditar(papel: UserRole) {
  return PESO[papel] >= PESO[UserRole.ADMIN];
}
