import { db } from "@/lib/db";
import { decifrar } from "@/lib/crypto";
import { IntegrationProvider } from "@/generated/prisma/enums";
import { conexaIntegration } from "@/server/integrations/conexa";
import { ConexaClient } from "@/server/integrations/conexa/client";
import {
  conexaConfigSchema,
  type ConexaConfig,
} from "@/server/integrations/conexa/config";
import type { ToolContext } from "@/server/integrations/types";

/**
 * O Conexa aberto pelo SISTEMA, sem modelo no meio — o irmão de
 * `clickup/sistema.ts`, e pelo mesmo motivo: decifrar credencial e montar o
 * contexto das ferramentas é a parte que não pode se duplicar.
 *
 * Quem usa hoje: o presente de aniversário, que lê a venda do pacote e reserva
 * pela MESMA `conexa_criar_reserva` dos agentes — com a conferência de conflito
 * de horário e a leitura de volta do que foi gravado. Reserva escrita à mão
 * aqui seria a cópia que diverge.
 *
 * ⚠ Desligado no painel é desligado para o sistema também.
 */
export type ConexaDoSistema = {
  cliente: ConexaClient;
  config: ConexaConfig;
  executar: (ferramenta: string, entrada: unknown) => Promise<unknown>;
};

export async function abrirConexa(
  quemChama: string,
): Promise<ConexaDoSistema | { erro: string }> {
  const integracao = await db.integration.findUnique({
    where: { provider: IntegrationProvider.CONEXA },
    include: { credential: true },
  });
  if (!integracao?.enabled) return { erro: "a integração do Conexa está desligada" };
  if (!integracao.credential) return { erro: "o Conexa está sem token" };

  const config = conexaConfigSchema.safeParse(integracao.config);
  if (!config.success) return { erro: "a configuração do Conexa está incompleta" };

  let credential: string;
  try {
    credential = decifrar(integracao.credential);
  } catch {
    return { erro: "não consegui decifrar o token do Conexa" };
  }

  const ctx: ToolContext = {
    provider: IntegrationProvider.CONEXA,
    config: integracao.config as Record<string, unknown>,
    credential,
    agentId: `sistema-${quemChama}`,
    // A trava de identidade não pede documento ao sistema: quem chama provou a
    // identidade antes (`ToolContext.sistema`).
    sistema: quemChama,
  };

  return {
    cliente: new ConexaClient(config.data, credential),
    config: config.data,
    async executar(ferramenta, entrada) {
      const definicao = conexaIntegration.tools.find((t) => t.name === ferramenta);
      if (!definicao) throw new Error(`a ferramenta ${ferramenta} não existe`);
      return definicao.execute(definicao.inputSchema.parse(entrada), ctx);
    },
  };
}
