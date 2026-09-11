import { getRedis } from "@/server/queue/conexao";
import { logger } from "@/lib/logger";

/**
 * Freio por token do MCP.
 *
 * Existe contra laço: um assistente que entra em repetição chamando a mesma
 * ferramenta centenas de vezes. O teto é folgado para gente — um levantamento
 * de todos os agentes, com prompt e ferramentas de cada um, cabe com sobra.
 *
 * ⚠ Falha ABERTO, ao contrário da mesa. Lá o pior caso de liberar é gasto sem
 * teto; aqui nenhuma ferramenta roda o modelo nem chama serviço pago, e o pior
 * caso é carga no banco. Barrar por Redis fora do ar deixaria sem painel
 * justamente quem está tentando entender por que o sistema caiu.
 *
 * ⚠ E com PRAZO. A conexão compartilhada tem `maxRetriesPerRequest: null`
 * (exigência do BullMQ): com o Redis fora do ar, um comando não falha — espera
 * para sempre. Sem o prazo, "falhar aberto" seria na verdade pendurar toda
 * chamada do MCP.
 */

export const TETO_POR_JANELA = 600;
export const JANELA_S = 10 * 60;
const PRAZO_DO_REDIS_MS = 1_500;

export type VereditoDoFreioMcp =
  | { pode: true }
  | { pode: false; esperaSegundos: number };

export async function consumirFreioMcp(
  tokenId: string,
): Promise<VereditoDoFreioMcp> {
  let prazo: ReturnType<typeof setTimeout> | undefined;
  const estourou = new Promise<"prazo">((resolve) => {
    prazo = setTimeout(() => resolve("prazo"), PRAZO_DO_REDIS_MS);
  });

  try {
    const veredito = await Promise.race([contar(tokenId), estourou]);
    if (veredito === "prazo") {
      logger.warn({ tokenId }, "freio do MCP sem resposta do Redis — liberando");
      return { pode: true };
    }
    return veredito;
  } catch (erro) {
    logger.warn({ erro, tokenId }, "freio do MCP não conseguiu contar — liberando");
    return { pode: true };
  } finally {
    clearTimeout(prazo);
  }
}

async function contar(tokenId: string): Promise<VereditoDoFreioMcp> {
  const redis = getRedis();
  const chave = `mcp:freio:${tokenId}`;

  const usos = await redis.incr(chave);
  // Só o primeiro uso define a validade: renovar a cada chamada faria a janela
  // nunca fechar para quem continua chamando.
  if (usos === 1) await redis.expire(chave, JANELA_S);
  if (usos <= TETO_POR_JANELA) return { pode: true };

  const ttl = await redis.ttl(chave);
  return { pode: false, esperaSegundos: ttl > 0 ? ttl : JANELA_S };
}
