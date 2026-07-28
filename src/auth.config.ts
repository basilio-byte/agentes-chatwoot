import type { NextAuthConfig } from "next-auth";

/**
 * Configuração compartilhada entre o middleware (edge) e o servidor.
 *
 * O provider de credenciais fica em `src/auth.ts` porque usa bcrypt e Prisma —
 * nenhum dos dois roda no edge runtime.
 */
export const authConfig = {
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 12, // 12h
  },
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id as string;
        token.role = user.role;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id;
        session.user.role = token.role;
      }
      return session;
    },
    authorized({ auth, request }) {
      const logado = Boolean(auth?.user);
      const { pathname } = request.nextUrl;

      // Públicas: login e a criação da conta inicial (que só existe enquanto
      // não houver nenhum usuário — a checagem fica na própria página).
      if (
        pathname.startsWith("/login") ||
        pathname.startsWith("/primeiro-acesso")
      ) {
        return true;
      }
      return logado;
    },
  },
} satisfies NextAuthConfig;
