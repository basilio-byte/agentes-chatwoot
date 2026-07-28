import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { UserRole } from "@/generated/prisma/enums";
import { exigirPapel } from "@/server/auth-guard";
import { criarAgente } from "@/server/actions/agents";
import { listarModelos } from "@/server/agents/catalogo";
import { AgenteForm } from "@/components/agente-form";

export default async function NovoAgentePage() {
  await exigirPapel(UserRole.ADMIN);
  const modelos = await listarModelos();

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <Link
          href="/agentes"
          className="inline-flex items-center gap-1 text-sm text-muted hover:underline"
        >
          <ArrowLeft size={14} aria-hidden />
          Agentes
        </Link>
        <h1 className="text-xl font-semibold">Novo agente</h1>
        <p className="text-sm text-muted">
          O agente nasce desligado. Teste no playground antes de ativar.
        </p>
      </div>

      <AgenteForm
        acao={criarAgente}
        modelos={modelos}
        rotuloEnvio="Criar agente"
      />
    </div>
  );
}
