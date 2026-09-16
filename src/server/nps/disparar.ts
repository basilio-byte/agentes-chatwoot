import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { IntegrationProvider } from "@/generated/prisma/enums";
import { lerCheckboxesMarcados } from "@/server/conversa-marcada/evento";
import { telefoneCanonico } from "@/server/integrations/clickup/telefone";
import { agendarPesquisaNps } from "@/server/queue/nps";
import { lerConfigNps } from "./config";

/**
 * Espera antes de mandar a pesquisa, a mesma do gatilho de checkbox: a automação
 * do Chatwoot que reage ao mesmo checkbox termina de escrever antes de o sistema
 * ler e mesclar os atributos da conversa.
 */
export const ESPERA_DO_ENVIO_MS = 3_000;

/**
 * O checkbox da pesquisa foi marcado: grava a pesquisa e adianta o relógio.
 *
 * Nunca lança, como os disparadores de gatilho: a rota de conta ainda sincroniza
 * a resolução e o dono depois disto.
 *
 * ⚠ Desligada, não faz NADA — nem desmarca o checkbox. É o que deixa o NPS do
 * n8n cuidar do mesmo checkbox até o dia em que esta função for ligada; com os
 * dois ligados, o cliente recebe a pesquisa em dobro.
 */
export async function dispararPesquisaNps(
  payload: unknown,
  agora = Date.now(),
): Promise<boolean> {
  const marcados = lerCheckboxesMarcados(payload, agora);
  if (!marcados) return false;

  try {
    const integracao = await db.integration.findUnique({
      where: { provider: IntegrationProvider.NPS },
      select: { enabled: true, config: true },
    });
    if (!integracao?.enabled) return false;

    const config = lerConfigNps(integracao.config);
    if (!marcados.atributos.includes(config.checkbox)) return false;
    if (marcados.inboxId == null || !config.caixas.includes(marcados.inboxId)) {
      return false;
    }

    let pesquisaId: string;
    try {
      const pesquisa = await db.pesquisaNps.create({
        data: {
          chatwootConversationId: marcados.conversationId,
          inboxId: marcados.inboxId,
          telefone: telefoneCanonico(marcados.telefone ?? ""),
          // O instante da marcação é a idempotência: o Chatwoot reenvia em
          // falha com o mesmo corpo, e a unique barra a segunda.
          marcadaEm: new Date(Math.round(marcados.marcadoEm * 1000)),
          venceEm: new Date(agora + ESPERA_DO_ENVIO_MS),
        },
        select: { id: true },
      });
      pesquisaId = pesquisa.id;
    } catch (erro) {
      if (ehConflitoDeUnique(erro)) return false;
      throw erro;
    }

    try {
      await agendarPesquisaNps(pesquisaId, ESPERA_DO_ENVIO_MS);
    } catch (erro) {
      // A pesquisa já está gravada: sem a fila, o vigia a manda no minuto seguinte.
      logger.warn({ erro, pesquisaId }, "NPS: não consegui enfileirar o envio — fica com o vigia");
    }
    return true;
  } catch (erro) {
    logger.error(
      { erro, conversa: marcados.conversationId },
      "NPS: não consegui registrar a pesquisa",
    );
    return false;
  }
}

function ehConflitoDeUnique(erro: unknown) {
  return (
    typeof erro === "object" &&
    erro !== null &&
    "code" in erro &&
    (erro as { code?: string }).code === "P2002"
  );
}
