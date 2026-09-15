import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { ChatwootClient } from "@/server/integrations/chatwoot/client";
import type { MensagemDoCiclo, Recorte } from "./ciclo";

/**
 * O que os dois gatilhos de conversa — resolvida e checkbox marcado — fazem
 * igual: ler o atendimento para trás e gravar o desfecho onde a tela mostra.
 */

/**
 * Páginas lidas para trás procurando o começo do atendimento. A API devolve 20
 * mensagens por página: são até 300, e acima disso a transcrição avisa que o
 * começo ficou de fora.
 */
export const PAGINAS_MAXIMAS = 15;

export type Desfecho = "executado" | "ignorado" | "falhou" | "interrompido";

/**
 * O atendimento inteiro, paginando para trás até achar o começo dele.
 *
 * Onde o atendimento começa e acaba quem decide é `recortar` — o instante da
 * resolução na conversa encerrada, o da marcação na conversa marcada. Aqui só se
 * lê até ele dizer que achou.
 *
 * `completa` falso quer dizer que as páginas acabaram antes do começo — só
 * acontece em conversa muito longa, e a transcrição avisa.
 */
export async function lerAtendimento(
  cliente: ChatwootClient,
  conversationId: number,
  recortar: (mensagens: MensagemDoCiclo[]) => Recorte,
): Promise<{ mensagens: MensagemDoCiclo[]; completa: boolean }> {
  const lidas: MensagemDoCiclo[] = [];
  let antesDe: number | undefined;

  for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina++) {
    const lote = await cliente.listarMensagensAntes(conversationId, antesDe);
    if (lote.length === 0) {
      // Chegou ao começo da conversa: é o primeiro atendimento dela.
      return { mensagens: recortar(lidas).mensagens, completa: true };
    }

    lidas.push(...lote);
    const recorte = recortar(lidas);
    if (recorte.achouOInicio) return { mensagens: recorte.mensagens, completa: true };

    antesDe = Math.min(...lote.map((m) => m.id));
  }

  const recorte = recortar(lidas);
  return { mensagens: recorte.mensagens, completa: recorte.achouOInicio };
}

/** Grava o desfecho na linha do gatilho (o que a tela mostra) e na entrega. */
export async function registrarDesfecho(
  dados: { gatilhoId: string; webhookEventId: string },
  resultado: Desfecho,
  detalhe: string,
) {
  const curto = detalhe.slice(0, 500);

  try {
    await db.gatilhoDeConversa.update({
      where: { id: dados.gatilhoId },
      data: {
        ultimaExecucaoEm: new Date(),
        ultimoResultado: resultado,
        ultimoDetalhe: curto,
      },
    });
  } catch (erro) {
    logger.warn(
      { gatilhoId: dados.gatilhoId, erro },
      "não consegui gravar o desfecho do gatilho de conversa",
    );
  }

  try {
    await db.webhookEvent.update({
      where: { id: dados.webhookEventId },
      data: { processedAt: new Date(), resultado, detalhe: curto },
    });
  } catch (erro) {
    logger.warn(
      { webhookEventId: dados.webhookEventId, erro },
      "não consegui marcar a entrega do gatilho de conversa",
    );
  }
}
