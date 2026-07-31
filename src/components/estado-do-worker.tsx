import { Aviso } from "@/components/ui";
import { formatarData } from "@/lib/utils";
import type { EstadoDoWorker } from "@/server/queue/batimento";

/**
 * "O worker está rodando?" — a primeira pergunta de toda investigação de
 * silêncio, e que antes só o log do container respondia.
 *
 * Sem worker, o webhook enfileira e nada acontece: a conversa aparece aqui com
 * zero respostas e nenhuma pista do motivo.
 */
export function EstadoDoWorker({ estado }: { estado: EstadoDoWorker }) {
  if (estado.vivo) return null;

  if (estado.indeterminado) {
    return (
      <Aviso tone="danger">
        Não consegui falar com o Redis, então não sei se o worker está rodando —
        e sem Redis não há fila: as mensagens não seriam nem enfileiradas.
        Confira <code className="font-mono">REDIS_URL</code>.
      </Aviso>
    );
  }

  return (
    <Aviso tone="danger">
      <strong>O worker não está rodando.</strong> As mensagens entram na fila e
      ficam lá — é por isso que a conversa aparece sem resposta. No Easypanel,
      defina <code className="font-mono">RUN_WORKER_IN_APP=true</code> e reinicie
      o serviço, ou suba um serviço próprio com{" "}
      <code className="font-mono">node worker.mjs</code>.
      {estado.ultimoBatimento
        ? ` Último sinal de vida: ${formatarData(estado.ultimoBatimento)}.`
        : " Nenhum sinal de vida registrado."}
    </Aviso>
  );
}
