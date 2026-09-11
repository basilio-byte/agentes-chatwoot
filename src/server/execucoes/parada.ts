import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { RunSource, RunStatus } from "@/generated/prisma/enums";
import { limparPedido, pedirParada } from "@/server/agents/cancelamento";
import { estadoDoWorker } from "@/server/queue/batimento";
import { auditar, type Autor, type Desfecho } from "@/server/gestao/autor";
import { IDADE_DE_ZUMBI_MS } from "./limites";
import { ONDE_RODA } from "./onde-roda";

/**
 * Pede para uma execução em andamento parar.
 *
 * Não mata nada de fora: deixa um recado no Redis e quem está rodando o turno
 * o encontra — entre etapas e durante a chamada ao modelo, que é onde o tempo
 * é gasto. O painel roda em outro processo que não o worker, então não há
 * memória compartilhada para tocar.
 *
 * Quem chama confere o papel (ADMIN): parar um turno interrompe um atendimento
 * com cliente do outro lado, e "Leitura" não muda produção.
 */
export async function pedirParadaDaExecucao(
  id: string,
  autor: Autor,
): Promise<Desfecho> {
  const run = await db.agentRun.findUnique({
    where: { id },
    select: { id: true, status: true, createdAt: true, source: true },
  });
  if (!run) return { erro: "Execução não encontrada." };

  if (run.status !== RunStatus.RUNNING) {
    return { erro: `Esta execução já terminou (${run.status.toLowerCase()}).` };
  }

  // É o nome que a nota interna do atendimento vai citar como quem parou.
  const quem = autor.mcp ? `${autor.nome}, pelo MCP` : autor.nome;
  const registrou = await pedirParada(run.id, quem);

  await auditar(autor, "run.stop.requested", "AgentRun", run.id);

  // Ninguém para receber o recado: o processo que gravou `RUNNING` já morreu, e
  // a linha ficaria "rodando" para sempre, poluindo a lista e o filtro. Fechar
  // aqui é o único jeito — e é seguro justamente porque não há turno vivo.
  const orfa = await ninguemVaiReceber(run);
  if (orfa) {
    await db.agentRun.updateMany({
      // O `status` no where evita a corrida com um turno que estava vivo e
      // terminou entre a leitura acima e esta escrita.
      where: { id: run.id, status: RunStatus.RUNNING },
      data: {
        status: RunStatus.CANCELED,
        error: autor.mcp
          ? `Execução encerrada pelo MCP por ${autor.nome} — nenhum processo estava tocando este turno.`
          : `Execução encerrada no painel por ${autor.nome} — nenhum processo estava tocando este turno.`,
        finishedAt: new Date(),
      },
    });
    await limparPedido(run.id);

    revalidatePath("/execucoes");
    return {
      ok: "Execução encerrada. Ela estava marcada como rodando, mas nenhum processo a estava tocando.",
    };
  }

  revalidatePath("/execucoes");

  if (!registrou) {
    return {
      erro: "Não consegui falar com o Redis para registrar o pedido. O turno segue rodando.",
    };
  }

  return {
    ok: "Pedido de parada enviado. O agente para na próxima verificação, em alguns segundos.",
  };
}

/**
 * A execução está órfã — sem processo vivo capaz de atender ao pedido?
 *
 * Duas evidências: idade absurda para um turno, ou worker morto. Para quem
 * roda no processo do painel só a idade vale — o batimento do worker não diz
 * nada sobre um turno que nunca esteve lá.
 */
async function ninguemVaiReceber(run: {
  createdAt: Date;
  source: RunSource;
}): Promise<boolean> {
  if (Date.now() - run.createdAt.getTime() > IDADE_DE_ZUMBI_MS) return true;
  // ⚠ Quem responde "onde isto roda" é o mapa, nunca uma comparação escrita
  // aqui: esta linha era `source === PLAYGROUND`, e origem nova que rodasse no
  // painel sem entrar na condição passaria a ser julgada pelo batimento do
  // worker — com o worker reiniciando, "parar" encerraria como `CANCELED` um
  // turno vivo e respondendo, sem erro e sem rastro.
  if (ONDE_RODA[run.source] === "painel") return false;

  const worker = await estadoDoWorker();
  // Indeterminado (Redis fora do ar) não é prova de morte: nesse caso não se
  // fecha nada, para não marcar como encerrado um turno que segue rodando.
  return !worker.vivo && !worker.indeterminado;
}
