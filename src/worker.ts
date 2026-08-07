/**
 * Entrada do processo worker.
 *
 * No Easypanel dá para rodar de dois jeitos, e a escolha é do deploy:
 *  - serviço separado, com a mesma imagem e `node worker.js` como comando;
 *  - dentro do container do app, com RUN_WORKER_IN_APP=true.
 */
import { logger } from "@/lib/logger";
import { iniciarWorker } from "@/server/queue/worker";

const worker = iniciarWorker();

async function encerrar(sinal: string) {
  logger.info({ sinal }, "encerrando worker");
  // `close()` espera os jobs em andamento terminarem antes de sair, para não
  // deixar cliente sem resposta no meio de um deploy. Os dois workers, não
  // só o de atendimento — matar um sem esperar o outro corta jobs de gatilho
  // em andamento sem necessidade.
  await Promise.all([worker.atendimento.close(), worker.gatilho.close()]);
  process.exit(0);
}

process.on("SIGTERM", () => void encerrar("SIGTERM"));
process.on("SIGINT", () => void encerrar("SIGINT"));

process.on("unhandledRejection", (motivo) => {
  logger.error({ motivo }, "promise rejeitada sem tratamento no worker");
});
