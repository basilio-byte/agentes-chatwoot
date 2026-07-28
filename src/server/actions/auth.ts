"use server";

import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";

export type EstadoLogin = { erro?: string };

export async function entrar(
  _estado: EstadoLogin,
  formData: FormData,
): Promise<EstadoLogin> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/agentes",
    });
    return {};
  } catch (erro) {
    // O signIn bem-sucedido lança um redirect — precisa subir intacto.
    if (erro instanceof AuthError) {
      return { erro: "E-mail ou senha inválidos." };
    }
    throw erro;
  }
}

export async function sair() {
  await signOut({ redirectTo: "/login" });
}
