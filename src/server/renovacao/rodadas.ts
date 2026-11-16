import { db } from "@/lib/db";

import { PROVIDER_RENOVACAO } from "./regras";

/**
 * O desfecho das rodadas da renovação automática, uma linha por dia e por parte
 * em `WebhookEvent` (`<chave>:<dia>`). É por aqui que a tela e o MCP respondem
 * "isto está rodando, e o que decidiu NÃO fazer?" sem abrir o log do contêiner.
 *
 * Chaves: `notificacao` (2b), `avanco` (status que ficou para trás),
 * `pagamento` (fase 4), `datas` (fase 3) e `propagacao`/`rodada` (já existiam).
 */
export const CHAVES_DAS_RODADAS = ["notificacao", "avanco", "pagamento", "datas"] as const;

export async function ultimasRodadasDa(chave: string, limite = 3) {
  return db.webhookEvent.findMany({
    where: { provider: PROVIDER_RENOVACAO, externalId: { startsWith: `${chave}:` } },
    select: { externalId: true, resultado: true, detalhe: true, processedAt: true },
    orderBy: { createdAt: "desc" },
    take: limite,
  });
}
