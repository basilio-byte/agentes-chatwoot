import IORedis from "ioredis";
import { env } from "@/lib/env";

/**
 * Conexão Redis compartilhada pela fila.
 *
 * `maxRetriesPerRequest: null` é exigência do BullMQ: com o padrão do ioredis,
 * o bloqueio longo do worker seria abortado como se fosse timeout.
 */
let conexao: IORedis | null = null;

export function getRedis(): IORedis {
  conexao ??= new IORedis(env().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return conexao;
}
