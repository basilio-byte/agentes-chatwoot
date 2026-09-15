"use server";

import { db } from "@/lib/db";
import { exigirPapel, exigirSessao } from "@/server/auth-guard";
import { EventoDeConversa, UserRole } from "@/generated/prisma/enums";
import { autorDaSessao } from "@/server/gestao/autor";
import {
  configurarGatilhoDeConversa,
  definirGatilhoDeConversa,
  lerContasDeAutomacao,
} from "@/server/gestao/gatilho-de-conversa";

export type EstadoGatilhoDeConversa = {
  ok?: string;
  erro?: string;
};

export type ResumoGatilhoDeConversa = {
  configurado: boolean;
  enabled: boolean;
  exigeAtendimentoHumano: boolean;
  contasDeAutomacao: string[];
  ultimaExecucaoEm: Date | null;
  ultimoResultado: string | null;
  ultimoDetalhe: string | null;
};

export async function resumoDoGatilhoDeConversa(
  agentId: string,
): Promise<ResumoGatilhoDeConversa> {
  // Função exportada de arquivo "use server" é endpoint, mesmo sendo leitura.
  await exigirSessao();

  const gatilho = await db.gatilhoDeConversa.findUnique({
    where: { agentId_evento: { agentId, evento: EventoDeConversa.RESOLVIDA } },
  });

  return {
    configurado: Boolean(gatilho),
    enabled: gatilho?.enabled ?? false,
    exigeAtendimentoHumano: gatilho?.exigeAtendimentoHumano ?? true,
    contasDeAutomacao: gatilho?.contasDeAutomacao ?? [],
    ultimaExecucaoEm: gatilho?.ultimaExecucaoEm ?? null,
    ultimoResultado: gatilho?.ultimoResultado ?? null,
    ultimoDetalhe: gatilho?.ultimoDetalhe ?? null,
  };
}

export async function salvarGatilhoDeConversa(
  agentId: string,
  _estado: EstadoGatilhoDeConversa,
  formData: FormData,
): Promise<EstadoGatilhoDeConversa> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const desfecho = await configurarGatilhoDeConversa(
    agentId,
    {
      exigeAtendimentoHumano: formData.get("exigeAtendimentoHumano") === "on",
      contasDeAutomacao: lerContasDeAutomacao(
        String(formData.get("contasDeAutomacao") ?? ""),
      ),
    },
    autorDaSessao(sessao),
  );

  return "erro" in desfecho ? { erro: desfecho.erro } : { ok: desfecho.ok };
}

export async function alternarGatilhoDeConversa(
  agentId: string,
  ligar: boolean,
): Promise<EstadoGatilhoDeConversa> {
  const sessao = await exigirPapel(UserRole.ADMIN);
  // A regra mora em `server/gestao/gatilho-de-conversa.ts`.
  const desfecho = await definirGatilhoDeConversa(agentId, ligar, autorDaSessao(sessao));
  return "erro" in desfecho ? { erro: desfecho.erro } : { ok: desfecho.ok };
}
