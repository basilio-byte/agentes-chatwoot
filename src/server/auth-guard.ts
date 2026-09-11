import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { UserRole } from "@/generated/prisma/enums";
import { alcancaPapel } from "@/lib/papeis";

/** Sessão obrigatória. Uso em páginas e server actions. */
export async function exigirSessao() {
  const sessao = await auth();
  if (!sessao?.user) redirect("/login");
  return sessao;
}

/**
 * Sessão + papel. Hierarquia: OWNER > ADMIN > VIEWER — a régua mora em
 * `lib/papeis.ts`, onde o MCP também a lê.
 * OWNER é o único que mexe em credenciais de integração.
 */
export async function exigirPapel(minimo: UserRole) {
  const sessao = await exigirSessao();
  if (!alcancaPapel(sessao.user.role, minimo)) {
    throw new Error("Sem permissão para esta ação.");
  }
  return sessao;
}

export function podeEditar(papel: UserRole) {
  return alcancaPapel(papel, UserRole.ADMIN);
}
