import { z } from "zod";
import { db } from "@/lib/db";
import { decifrar } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { obterIntegracao } from "./registry";
import type {
  IntegrationDefinition,
  ToolContext,
  ToolDefinition,
} from "./types";
import type { IntegrationProvider } from "@/generated/prisma/enums";

export type ToolResolvida = {
  definicao: ToolDefinition;
  provider: IntegrationProvider;
  /** Contexto sem os campos que só existem em runtime (agentId, conversa). */
  configuracao: Pick<ToolContext, "config" | "credential">;
};

/**
 * Resolve quais tools um agente pode usar.
 *
 * O toggle é de **dois níveis** e a interseção acontece aqui:
 *   1. `Integration.enabled`      — global, desliga para todos os agentes
 *   2. `AgentIntegration.enabled` — por agente, + allowlist de tools
 *
 * Integração desligada simplesmente não aparece para o modelo. Não existe tool
 * que responde "desabilitado" — isso gastaria token e confundiria a decisão.
 */
export async function resolverToolsDoAgente(
  agentId: string,
): Promise<Map<string, ToolResolvida>> {
  const vinculos = await db.agentIntegration.findMany({
    where: {
      agentId,
      enabled: true, // nível 2
      integration: { enabled: true }, // nível 1
    },
    include: { integration: { include: { credential: true } } },
  });

  const resolvidas = new Map<string, ToolResolvida>();

  for (const vinculo of vinculos) {
    const { integration } = vinculo;
    const definicao = obterIntegracao(integration.provider);

    if (!definicao) {
      // Configurada no banco mas sem módulo no registry (ex.: aguardando a doc de API).
      logger.warn(
        { provider: integration.provider, agentId },
        "integração habilitada sem implementação no registry — ignorada",
      );
      continue;
    }

    let credential: string | null = null;
    if (integration.credential) {
      try {
        credential = decifrar(integration.credential);
      } catch (erro) {
        logger.error(
          { provider: integration.provider, erro },
          "falha ao decifrar credencial — integração ignorada nesta execução",
        );
        continue;
      }
    }

    const configuracao = {
      config: integration.config as Record<string, unknown>,
      credential,
    };

    for (const tool of toolsLiberadas(definicao, vinculo.allowedTools)) {
      resolvidas.set(tool.name, {
        definicao: tool,
        provider: integration.provider,
        configuracao,
      });
    }
  }

  return resolvidas;
}

/**
 * O que a allowlist de um vínculo libera. **Vazia = todas as tools da
 * integração** — e é por isso que ninguém pode gravar vazio querendo dizer
 * "nenhuma" (ver `definirFerramentasDoAgente`).
 *
 * Exportada para o MCP contar ferramentas de vários agentes sem decifrar
 * credencial de cada um, com a mesma regra do turno.
 */
export function toolsLiberadas(
  definicao: IntegrationDefinition,
  allowedTools: string[],
): ToolDefinition[] {
  const permitidas = new Set(allowedTools);
  return definicao.tools.filter(
    (tool) => permitidas.size === 0 || permitidas.has(tool.name),
  );
}

/**
 * Converte as tools resolvidas para o formato `function` da API de chat
 * completions (que é o protocolo que a OpenRouter fala).
 *
 * A ordenação por nome não é cosmética: as tools entram no início do prompt, e
 * manter a ordem estável preserva o cache automático de prefixo dos provedores.
 */
/**
 * Estimativa do que uma tool ocupa no prompt.
 *
 * Serve para a tela do agente mostrar o custo de liberar cada ferramenta — as
 * tools entram em **toda** mensagem, então a conta importa. É aproximação por
 * caracteres, não tokenização real: o número exato varia por modelo e não
 * compensa carregar um tokenizador para exibir uma ordem de grandeza.
 */
export function tokensAproximadosDaTool(definicao: ToolDefinition): number {
  const jsonSchema = z.toJSONSchema(definicao.inputSchema, {
    io: "input",
  }) as Record<string, unknown>;
  delete jsonSchema.$schema;

  const bruto = JSON.stringify({
    name: definicao.name,
    description: definicao.description,
    parameters: jsonSchema,
  });

  return Math.round(bruto.length / 3.6);
}

export function paraFerramentasOpenAI(resolvidas: Map<string, ToolResolvida>) {
  return [...resolvidas.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([nome, { definicao }]) => {
      const jsonSchema = z.toJSONSchema(definicao.inputSchema, {
        io: "input",
      }) as Record<string, unknown>;
      delete jsonSchema.$schema;

      return {
        type: "function" as const,
        function: {
          name: nome,
          description: definicao.description,
          parameters: jsonSchema,
        },
      };
    });
}
