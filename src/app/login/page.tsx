import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { FormularioLogin } from "./formulario";

export default async function LoginPage() {
  // Deploy novo, banco vazio: manda direto para a criação da conta inicial em
  // vez de mostrar um login que ninguém consegue passar.
  if ((await db.user.count()) === 0) redirect("/primeiro-acesso");

  return <FormularioLogin />;
}
