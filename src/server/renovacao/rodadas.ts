import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { diaEmSaoPaulo } from "@/lib/tempo";

import { PROVIDER_RENOVACAO } from "./regras";
import { lerResumoAnterior, serializarResumo, somarAoDia } from "./resumo-do-dia";

/**
 * O desfecho das rodadas da renovação automática, uma linha por dia e por parte
 * em `WebhookEvent` (`<chave>:<dia>`). É por aqui que a tela e o MCP respondem
 * "isto está rodando, e o que decidiu NÃO fazer?" sem abrir o log do contêiner.
 *
 * Chaves: `notificacao` (2b), `avanco` (status que ficou para trás),
 * `pagamento` (fase 4), `datas` (fase 3), `mensagens` (o WhatsApp ao cliente
 * ONE) e `propagacao`/`rodada` (já existiam).
 *
 * ⚠ As reservas do WhatsApp usam OUTRO prefixo (`whatsapp:`): `mensagens:<dia>`
 * é só o resumo, e uma reserva com o mesmo prefixo apareceria na lista dos
 * resumos (a mesma colisão que `pagamento:` já teve).
 */
export const CHAVES_DAS_RODADAS = ["notificacao", "avanco", "pagamento", "datas", "mensagens"] as const;

/**
 * Grava o resumo do dia de uma parte, SOMANDO ao que as rodadas anteriores do
 * mesmo dia já gravaram (ver `resumo-do-dia.ts`). `resultado` recebe o resumo já
 * somado, para dizer "propagado" se ALGUMA rodada do dia escreveu. Nunca lança:
 * resumo que não grava não pode derrubar a rodada que fez o trabalho.
 */
export async function gravarResumoDoDia(entrada: {
  chave: string;
  eventType: string;
  agora: Date;
  rodada: Record<string, unknown>;
  campos: { listas?: readonly string[]; contadores?: readonly string[] };
  resultado: (somado: Record<string, unknown>) => string;
}) {
  try {
    const externalId = `${entrada.chave}:${diaEmSaoPaulo(entrada.agora)}`;
    const anterior = await db.webhookEvent.findUnique({
      where: { provider_externalId: { provider: PROVIDER_RENOVACAO, externalId } },
      select: { detalhe: true },
    });
    const somado = somarAoDia(lerResumoAnterior(anterior?.detalhe), entrada.rodada, entrada.campos);
    const dados = {
      resultado: entrada.resultado(somado),
      detalhe: serializarResumo(somado),
      processedAt: entrada.agora,
    };
    await db.webhookEvent.upsert({
      where: { provider_externalId: { provider: PROVIDER_RENOVACAO, externalId } },
      create: {
        provider: PROVIDER_RENOVACAO,
        externalId,
        eventType: entrada.eventType,
        payload: {},
        ...dados,
      },
      update: dados,
    });
  } catch (erro) {
    logger.error({ erro, chave: entrada.chave }, "renovação: não consegui registrar o resumo do dia");
  }
}

export async function ultimasRodadasDa(chave: string, limite = 3) {
  return db.webhookEvent.findMany({
    where: { provider: PROVIDER_RENOVACAO, externalId: { startsWith: `${chave}:` } },
    select: { externalId: true, resultado: true, detalhe: true, processedAt: true },
    orderBy: { createdAt: "desc" },
    take: limite,
  });
}
