"use server";

import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { IntegrationProvider, UserRole } from "@/generated/prisma/enums";

export type EstadoBootstrap = {
  erro?: string;
  camposComErro?: Record<string, string>;
};

const schema = z.object({
  name: z.string().min(2, "Informe o nome"),
  email: z.email("E-mail inválido"),
  password: z.string().min(10, "Use pelo menos 10 caracteres"),
  token: z.string().optional(),
});

const CATALOGO: Record<IntegrationProvider, string> = {
  [IntegrationProvider.CHATWOOT]: "Chatwoot",
  [IntegrationProvider.CLICKUP]: "ClickUp",
  [IntegrationProvider.CONEXA]: "ERP Conexa",
  [IntegrationProvider.ZAPSIGN]: "ZapSign",
  [IntegrationProvider.OPENAI]: "OpenAI — leitura de mídia",
};

/**
 * Cria a conta OWNER inicial.
 *
 * Existe porque o `prisma db seed` depende de dependências de desenvolvimento
 * que não vão para a imagem de produção — sem isto, um deploy novo sobe sem
 * ninguém conseguir entrar.
 *
 * Só funciona enquanto **não houver nenhum usuário**. Depois disso a rota some.
 */
export async function criarPrimeiroUsuario(
  _estado: EstadoBootstrap,
  formData: FormData,
): Promise<EstadoBootstrap> {
  if ((await db.user.count()) > 0) {
    return { erro: "Já existe uma conta. Use a tela de login." };
  }

  const parsed = schema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    token: formData.get("token") ?? undefined,
  });

  if (!parsed.success) {
    return {
      erro: "Confira os campos destacados.",
      camposComErro: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join("."), i.message]),
      ),
    };
  }

  // Proteção opcional: com BOOTSTRAP_TOKEN definido, só quem tem o token cria a
  // conta. Sem ele, a janela entre o deploy e o primeiro acesso fica aberta.
  const esperado = env().BOOTSTRAP_TOKEN;
  if (esperado && parsed.data.token !== esperado) {
    logger.warn("tentativa de primeiro acesso com token inválido");
    return {
      erro: "Token de instalação inválido.",
      camposComErro: { token: "Não confere" },
    };
  }

  await db.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email.toLowerCase(),
        passwordHash: await bcrypt.hash(parsed.data.password, 12),
        role: UserRole.OWNER,
      },
    });

    // As linhas de integração normalmente vêm do seed, que não roda em produção.
    for (const [provider, label] of Object.entries(CATALOGO)) {
      await tx.integration.upsert({
        where: { provider: provider as IntegrationProvider },
        update: {},
        create: {
          provider: provider as IntegrationProvider,
          label,
          enabled: false,
        },
      });
    }
  });

  logger.info(
    { email: parsed.data.email },
    "conta inicial criada pelo primeiro acesso",
  );

  redirect("/login");
}
