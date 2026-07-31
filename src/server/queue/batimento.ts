import { getRedis } from "./conexao";
import { logger } from "@/lib/logger";

/**
 * Sinal de vida do worker.
 *
 * Existe porque "o worker está rodando?" era a primeira pergunta em toda
 * investigação de silêncio, e a única forma de responder era abrir o log do
 * container. Sem worker, o webhook enfileira e nada acontece — o painel mostra
 * a conversa com zero respostas e nenhuma pista.
 */
const CHAVE = "seahub:worker:batimento";

/** Folga generosa: o intervalo é de 20s, então 3 perdidos ainda não é morte. */
export const TOLERANCIA_MS = 75_000;
const INTERVALO_MS = 20_000;

export function iniciarBatimento(): NodeJS.Timeout {
  const bater = async () => {
    try {
      // TTL um pouco acima da tolerância: worker morto some sozinho da chave,
      // em vez de deixar um horário antigo parecendo estado atual.
      await getRedis().set(CHAVE, String(Date.now()), "PX", TOLERANCIA_MS * 2);
    } catch (erro) {
      logger.warn({ erro }, "falha ao registrar batimento do worker");
    }
  };

  void bater();
  const timer = setInterval(bater, INTERVALO_MS);
  // Não segura o processo aberto se tudo mais terminar.
  timer.unref?.();
  return timer;
}

export type EstadoDoWorker = {
  vivo: boolean;
  ultimoBatimento: Date | null;
  /** Redis fora do ar — não dá para afirmar nada sobre o worker. */
  indeterminado?: boolean;
};

export async function estadoDoWorker(): Promise<EstadoDoWorker> {
  try {
    const valor = await getRedis().get(CHAVE);
    if (!valor) return { vivo: false, ultimoBatimento: null };

    const quando = Number(valor);
    if (!Number.isFinite(quando)) return { vivo: false, ultimoBatimento: null };

    return {
      vivo: Date.now() - quando <= TOLERANCIA_MS,
      ultimoBatimento: new Date(quando),
    };
  } catch (erro) {
    logger.warn({ erro }, "não consegui ler o batimento do worker");
    return { vivo: false, ultimoBatimento: null, indeterminado: true };
  }
}
