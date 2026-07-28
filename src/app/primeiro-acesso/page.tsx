import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { FormularioPrimeiroAcesso } from "./formulario";

/**
 * Criação da conta inicial após um deploy novo. Some assim que existir
 * qualquer usuário.
 */
export default async function PrimeiroAcessoPage() {
  if ((await db.user.count()) > 0) redirect("/login");

  return (
    <FormularioPrimeiroAcesso exigeToken={Boolean(env().BOOTSTRAP_TOKEN)} />
  );
}
