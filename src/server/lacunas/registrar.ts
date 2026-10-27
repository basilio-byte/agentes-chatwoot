import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { limparTexto, ocultarDadosPessoais, tipoDaCausa, type Causa } from "./regras";

/**
 * Grava uma lacuna do agente — o "o que faltou" de uma transferência por
 * incapacidade. Ver `LacunaDoAgente` no schema.
 *
 * ⚠ **Nunca lança, e é o ponto.** É chamada de dentro de
 * `transferir_para_humano`, o fim de linha do atendimento: relatório que
 * quebra a transferência deixaria o cliente sem ninguém por causa de uma
 * anotação para a equipe. Falha vira log; a transferência segue.
 *
 * Devolve `true` quando gravou, para o teste e o log — a ferramenta não
 * depende disso.
 */
export async function registrarLacuna(args: {
  agentId: string;
  runId?: string;
  chatwootConversationId: number;
  causa: Causa;
  oQueFaltou?: string;
  motivo: string;
}): Promise<boolean> {
  const tipo = tipoDaCausa(args.causa);
  if (!tipo) return false;

  try {
    // Uma lacuna por execução: o modelo repete chamada, o proxy duplica pedido
    // de ferramenta, e o relatório mostraria o mesmo problema duas vezes. Sem
    // `runId` (chamada fora de um turno) não há como identificar — grava.
    if (args.runId) {
      const jaRegistrada = await db.lacunaDoAgente.findFirst({
        where: { runId: args.runId },
        select: { id: true },
      });
      if (jaRegistrada) return false;
    }

    await db.lacunaDoAgente.create({
      data: {
        agentId: args.agentId,
        runId: args.runId ?? null,
        chatwootConversationId: args.chatwootConversationId,
        tipo,
        oQueFaltou: limparTexto(ocultarDadosPessoais(args.oQueFaltou ?? "")),
        motivo: limparTexto(ocultarDadosPessoais(args.motivo)),
      },
    });
    return true;
  } catch (erro) {
    logger.error(
      {
        erro: erro instanceof Error ? erro.message : String(erro),
        agentId: args.agentId,
        runId: args.runId,
      },
      "falha ao registrar lacuna do agente",
    );
    return false;
  }
}
