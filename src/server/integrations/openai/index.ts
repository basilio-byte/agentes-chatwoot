import { IntegrationProvider } from "@/generated/prisma/enums";
import type { IntegrationDefinition } from "../types";
import { openaiConfigSchema, lerConfigOpenAI, modeloDeDocumento } from "./config";
import { criarClienteOpenAI, listarModelosDaConta } from "./client";

/**
 * Leitura de mídia pela OpenAI.
 *
 * A única integração do registry com **zero tools** — de propósito. Ela não dá
 * uma ferramenta ao agente: ela prepara o contexto antes de ele pensar, trocando
 * o áudio, a foto e o PDF que o cliente mandou por texto que o modelo lê.
 *
 * Está no registry mesmo assim porque o que ela precisa é exatamente o que o
 * registry já resolve: credencial cifrada, toggle global, toggle por agente e
 * um lugar conhecido no painel. Uma tabela paralela só para isso seria
 * capacidade duplicada — e capacidade duplicada é a que diverge.
 *
 * ⚠ O toggle por agente vale para o agente **dono do bot** (a porta), não para
 * quem assume por transferência. Ver `credenciais.ts`.
 */
export const openaiIntegration: IntegrationDefinition = {
  provider: IntegrationProvider.OPENAI,
  label: "OpenAI — leitura de mídia",
  descricao:
    "Transcreve áudio e lê imagem e documento que o cliente manda, antes de o agente responder. Não expõe ferramenta nenhuma: o agente simplesmente passa a enxergar o anexo.",
  configSchema: openaiConfigSchema,
  credentialLabel: "API key da OpenAI",

  async testarConexao(ctx) {
    if (!ctx.credential) {
      return { ok: false, mensagem: "Cadastre a API key da OpenAI antes de testar." };
    }

    const config = lerConfigOpenAI(ctx.config);
    const cliente = criarClienteOpenAI(config, ctx.credential);

    try {
      const modelos = await listarModelosDaConta(cliente);
      const faltando = [
        config.lerAudio ? config.modeloAudio : null,
        config.lerImagem ? config.modeloVisao : null,
        config.lerDocumento ? modeloDeDocumento(config) : null,
      ].filter((m): m is string => Boolean(m) && !modelos.includes(m!));

      if (faltando.length > 0) {
        return {
          ok: false,
          mensagem: `A chave funciona (${modelos.length} modelos na conta), mas estes ids não existem nela: ${[
            ...new Set(faltando),
          ].join(", ")}. Confira a grafia em Modelos.`,
        };
      }

      return {
        ok: true,
        mensagem: `Conexão bem-sucedida. ${modelos.length} modelos disponíveis nesta conta, e os que você configurou existem.`,
      };
    } catch (erro) {
      const status = (erro as { status?: number } | null)?.status;

      if (status === 401) {
        return { ok: false, mensagem: "A OpenAI recusou a chave (401). Confira se colou a chave certa e se ela não foi revogada." };
      }
      // Chave com escopo restrito não lê a lista de modelos, e isso não quer
      // dizer que ela não sirva para transcrever. Mesmo caso do token de Agent
      // Bot do Chatwoot: chamar de "recusada" manda trocar credencial boa.
      if (status === 403) {
        return {
          ok: false,
          indeterminado: true,
          mensagem:
            "A chave respondeu, mas não tem permissão para listar modelos (403) — o que é normal em chave restrita. Não dá para confirmar por aqui: use o teste com arquivo abaixo.",
        };
      }

      return {
        ok: false,
        mensagem:
          erro instanceof Error ? `Falha ao falar com a OpenAI: ${erro.message}` : "Falha desconhecida.",
      };
    }
  },

  tools: [],
};
