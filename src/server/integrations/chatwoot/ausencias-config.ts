import { IntegrationProvider } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { agoraEmSaoPaulo } from "@/lib/tempo";
import { ausenciasDaConfig, type Ausencia, type OpcoesDeAusencia } from "./ausencias";

/**
 * Lê as ausências da configuração do Chatwoot para o resolver de nomes.
 *
 * Cache de 30 s na memória do processo: o resolver roda a cada atribuição, e
 * uma consulta a mais por atribuição seria desperdício. O preço é que editar a
 * tela vale em até 30 s no outro processo (o worker é separado do painel).
 *
 * ⚠ NUNCA lança. Se o banco falhar, vale a última leitura (ou nenhuma ausência):
 * o pior caso é a conversa ir para quem foi pedido — o comportamento de sempre —,
 * e não o atendimento parar por causa de um recurso de conveniência.
 */

const VALIDADE_MS = 30_000;

let guardado: { em: number; ausencias: Ausencia[] } | null = null;

export async function opcoesDeAusencia(agora = Date.now()): Promise<OpcoesDeAusencia> {
  if (!guardado || agora - guardado.em > VALIDADE_MS) {
    try {
      const registro = await db.integration.findUnique({
        where: { provider: IntegrationProvider.CHATWOOT },
        select: { config: true },
      });
      guardado = { em: agora, ausencias: ausenciasDaConfig(registro?.config) };
    } catch (erro) {
      logger.warn({ erro }, "não consegui ler as ausências da equipe — vale a última leitura");
      guardado = { em: agora, ausencias: guardado?.ausencias ?? [] };
    }
  }
  return { ausencias: guardado.ausencias, hoje: agoraEmSaoPaulo(new Date(agora)).iso };
}

/** Esquece a leitura guardada: a tela chama depois de salvar, e os testes entre casos. */
export function esquecerAusencias() {
  guardado = null;
}
