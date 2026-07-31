import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Poda o histórico de entregas de webhook.
 *
 * Cada mensagem do cliente vira uma linha com o payload inteiro em JSON. Sem
 * poda, a tabela cresce para sempre carregando dados que só servem para
 * diagnosticar o passado recente — e o payload guarda conteúdo de conversa,
 * que não há motivo para reter indefinidamente.
 *
 * Roda no worker porque ele é o único processo longo que já existe; criar um
 * cron separado para isto seria mais peça para manter.
 */
export const DIAS_DE_RETENCAO = 30;
const INTERVALO_MS = 6 * 60 * 60 * 1000; // 6h

export async function podarEntregas(dias = DIAS_DE_RETENCAO): Promise<number> {
  const corte = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

  const { count } = await db.webhookEvent.deleteMany({
    where: { createdAt: { lt: corte } },
  });

  if (count > 0) {
    logger.info({ removidas: count, dias }, "entregas antigas podadas");
  }
  return count;
}

export function iniciarLimpeza(): NodeJS.Timeout {
  const rodar = async () => {
    try {
      await podarEntregas();
    } catch (erro) {
      // Falha aqui não pode derrubar o atendimento: é manutenção, não caminho
      // crítico.
      logger.warn({ erro }, "poda de entregas falhou");
    }
  };

  void rodar();
  const timer = setInterval(rodar, INTERVALO_MS);
  timer.unref?.();
  return timer;
}
