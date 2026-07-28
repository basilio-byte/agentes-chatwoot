import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { authConfig } from "@/auth.config";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

const credenciaisSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "E-mail", type: "email" },
        password: { label: "Senha", type: "password" },
      },
      authorize: async (credenciais) => {
        const parsed = credenciaisSchema.safeParse(credenciais);
        if (!parsed.success) return null;

        const usuario = await db.user.findUnique({
          where: { email: parsed.data.email.toLowerCase() },
        });

        // Mesma resposta para usuário inexistente, inativo ou senha errada —
        // não entregar ao atacante qual dos três aconteceu.
        if (!usuario || !usuario.active) return null;

        const senhaConfere = await bcrypt.compare(
          parsed.data.password,
          usuario.passwordHash,
        );
        if (!senhaConfere) {
          logger.warn({ email: parsed.data.email }, "tentativa de login falhou");
          return null;
        }

        return {
          id: usuario.id,
          name: usuario.name,
          email: usuario.email,
          role: usuario.role,
        };
      },
    }),
  ],
});
