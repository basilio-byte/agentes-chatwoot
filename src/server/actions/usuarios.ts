"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { exigirPapel, exigirSessao } from "@/server/auth-guard";
import { podeAlterarPapel, podeAlternarAtivo } from "@/server/usuarios/regras";
import { UserRole } from "@/generated/prisma/enums";

export type EstadoUsuario = {
  ok?: string;
  erro?: string;
  camposComErro?: Record<string, string>;
};

const novoUsuarioSchema = z.object({
  name: z.string().min(2, "Informe o nome"),
  email: z.email("E-mail inválido"),
  password: z.string().min(10, "Use pelo menos 10 caracteres"),
  role: z.enum(UserRole),
});

function erros(issues: z.ZodIssue[]): EstadoUsuario {
  return {
    erro: "Confira os campos destacados.",
    camposComErro: Object.fromEntries(
      issues.map((i) => [i.path.join("."), i.message]),
    ),
  };
}

/** Proprietários ativos além do alvo — entrada das regras em `usuarios/regras`. */
async function outrosOwnersAtivos(userId: string) {
  return db.user.count({
    where: { role: UserRole.OWNER, active: true, id: { not: userId } },
  });
}

export async function criarUsuario(
  _estado: EstadoUsuario,
  formData: FormData,
): Promise<EstadoUsuario> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const parsed = novoUsuarioSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    role: formData.get("role"),
  });
  if (!parsed.success) return erros(parsed.error.issues);

  const email = parsed.data.email.toLowerCase();
  if (await db.user.findUnique({ where: { email } })) {
    return {
      erro: "Já existe uma conta com esse e-mail.",
      camposComErro: { email: "E-mail em uso" },
    };
  }

  const usuario = await db.user.create({
    data: {
      name: parsed.data.name,
      email,
      passwordHash: await bcrypt.hash(parsed.data.password, 12),
      role: parsed.data.role,
    },
  });

  await auditar(sessao.user.id, "user.created", usuario.id);
  revalidatePath("/usuarios");
  return { ok: `Conta de ${usuario.name} criada.` };
}

export async function alterarPapel(
  userId: string,
  papel: UserRole,
): Promise<EstadoUsuario> {
  const sessao = await exigirPapel(UserRole.OWNER);
  const alvo = await db.user.findUniqueOrThrow({ where: { id: userId } });

  const veredito = podeAlterarPapel(alvo, papel, {
    meuId: sessao.user.id,
    outrosOwnersAtivos: await outrosOwnersAtivos(userId),
  });
  if (!veredito.permitido) return { erro: veredito.motivo };

  await db.user.update({ where: { id: userId }, data: { role: papel } });
  await auditar(sessao.user.id, `user.role.${papel.toLowerCase()}`, userId);

  revalidatePath("/usuarios");
  return { ok: "Papel atualizado." };
}

export async function alternarAtivoUsuario(
  userId: string,
): Promise<EstadoUsuario> {
  const sessao = await exigirPapel(UserRole.OWNER);
  const usuario = await db.user.findUniqueOrThrow({ where: { id: userId } });

  const veredito = podeAlternarAtivo(usuario, {
    meuId: sessao.user.id,
    outrosOwnersAtivos: await outrosOwnersAtivos(userId),
  });
  if (!veredito.permitido) return { erro: veredito.motivo };

  await db.user.update({
    where: { id: userId },
    data: { active: !usuario.active },
  });
  await auditar(
    sessao.user.id,
    usuario.active ? "user.deactivated" : "user.activated",
    userId,
  );

  revalidatePath("/usuarios");
  return { ok: usuario.active ? "Conta desativada." : "Conta reativada." };
}

export async function redefinirSenha(
  userId: string,
  _estado: EstadoUsuario,
  formData: FormData,
): Promise<EstadoUsuario> {
  const sessao = await exigirPapel(UserRole.OWNER);

  const senha = String(formData.get("password") ?? "");
  if (senha.length < 10) {
    return {
      erro: "Senha muito curta.",
      camposComErro: { password: "Use pelo menos 10 caracteres" },
    };
  }

  await db.user.update({
    where: { id: userId },
    data: { passwordHash: await bcrypt.hash(senha, 12) },
  });
  await auditar(sessao.user.id, "user.password.reset", userId);

  revalidatePath("/usuarios");
  return { ok: "Senha redefinida." };
}

/** Troca da própria senha — qualquer papel pode. */
export async function trocarMinhaSenha(
  _estado: EstadoUsuario,
  formData: FormData,
): Promise<EstadoUsuario> {
  const sessao = await exigirSessao();

  const atual = String(formData.get("atual") ?? "");
  const nova = String(formData.get("nova") ?? "");

  if (nova.length < 10) {
    return {
      erro: "Senha muito curta.",
      camposComErro: { nova: "Use pelo menos 10 caracteres" },
    };
  }

  const usuario = await db.user.findUniqueOrThrow({
    where: { id: sessao.user.id },
  });

  if (!(await bcrypt.compare(atual, usuario.passwordHash))) {
    return {
      erro: "Senha atual incorreta.",
      camposComErro: { atual: "Não confere" },
    };
  }

  await db.user.update({
    where: { id: usuario.id },
    data: { passwordHash: await bcrypt.hash(nova, 12) },
  });
  await auditar(usuario.id, "user.password.changed", usuario.id);

  return { ok: "Senha alterada." };
}

async function auditar(userId: string, action: string, entityId: string) {
  await db.auditLog.create({
    data: { userId, action, entity: "User", entityId },
  });
}
