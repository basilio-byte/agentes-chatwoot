import { logger } from "@/lib/logger";
import { clienteDoAgente } from "@/server/integrations/chatwoot/credenciais";
import type { ToolContext } from "@/server/integrations/types";
import {
  atributosParaOContato,
  LISTAS_DO_CRM,
  type DefinicaoDeAtributo,
} from "./regras";

/**
 * Depois de criar a task do CRM, o que ela traz vai também para o cadastro do
 * contato no Chatwoot (regras e motivo em `regras.ts`).
 *
 * - **É do SISTEMA, não do agente.** Depende de o modelo lembrar de uma segunda
 *   ferramenta, e o que o modelo pula aqui é cadastro vazio na tela de quem
 *   atende. Fica dentro da criação da task: onde a task nasce, o contato recebe.
 * - **Nunca lança e nunca atrasa a criação**: a task é o registro que importa, o
 *   espelho é conveniência. Falha vira log.
 * - **Só em task das listas do CRM e só dentro de uma conversa.**
 */

const VALIDADE_MS = 60 * 60_000;
let guardadas: { em: number; definicoes: DefinicaoDeAtributo[] } | null = null;

export async function espelharTaskNoContato(args: {
  ctx: Pick<ToolContext, "chatwootConversationId" | "canalAgentId" | "agentId">;
  listaId: string;
  campos: { campo: string; valor: unknown }[] | undefined;
}): Promise<string[]> {
  try {
    const { ctx, listaId, campos } = args;
    if (!ctx.chatwootConversationId || !campos?.length) return [];
    if (!LISTAS_DO_CRM.includes(listaId)) return [];

    const cliente = await clienteDoAgente(ctx.canalAgentId ?? ctx.agentId);
    if (!cliente) return [];

    const conversa = await cliente.obterConversa(ctx.chatwootConversationId);
    if (!conversa.contactId) return [];

    const [contato, definicoes] = await Promise.all([
      cliente.obterContato(conversa.contactId),
      definicoesDosAtributos(() => cliente.listarDefinicoesDeAtributosDoContato()),
    ]);

    const novos = atributosParaOContato(campos, definicoes, contato.atributos);
    const chaves = Object.keys(novos);
    if (chaves.length === 0) return [];

    await cliente.definirAtributosDoContato(conversa.contactId, novos);
    logger.info(
      { conversa: ctx.chatwootConversationId, chaves },
      "task do CRM espelhada no contato do Chatwoot",
    );
    return chaves;
  } catch (erro) {
    logger.warn(
      { erro: erro instanceof Error ? erro.message.slice(0, 200) : String(erro) },
      "task do CRM: o contato do Chatwoot não foi atualizado",
    );
    return [];
  }
}

async function definicoesDosAtributos(
  ler: () => Promise<DefinicaoDeAtributo[]>,
  agora = Date.now(),
): Promise<DefinicaoDeAtributo[]> {
  if (guardadas && agora - guardadas.em < VALIDADE_MS) return guardadas.definicoes;
  try {
    const definicoes = await ler();
    guardadas = { em: agora, definicoes };
    return definicoes;
  } catch (erro) {
    // Sem as opções, atributo de lista não é gravado — o resto segue.
    logger.warn(
      { erro: erro instanceof Error ? erro.message.slice(0, 200) : String(erro) },
      "contato: definições dos atributos não lidas",
    );
    return guardadas?.definicoes ?? [];
  }
}

/** Só para teste. */
export function esquecerDefinicoes() {
  guardadas = null;
}
