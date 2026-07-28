import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

// Convenção `proxy` do Next 16 (era `middleware` até o 15).
// Só a config compartilhada — sem providers, para continuar rodando no edge
// (bcrypt e Prisma não rodam lá).
export default NextAuth(authConfig).auth;

export const config = {
  matcher: [
    // Só as páginas. `/api/*` fica de fora de propósito: um redirect para a tela
    // de login devolveria HTML onde o cliente espera JSON.
    //
    // ⚠ Toda rota em /api/ é responsável pela própria checagem de sessão.
    "/((?!api|_next/static|_next/image|favicon.ico).*)",
  ],
};
