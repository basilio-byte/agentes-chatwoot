import { logger } from "@/lib/logger";
import { getRedis } from "@/server/queue/conexao";

/**
 * Parar uma execução em andamento.
 *
 * O pedido nasce no painel (processo do Next) e precisa chegar a quem está
 * rodando o turno (processo do worker). Os dois já compartilham o Redis, então
 * é ele o canal — mesmo padrão do batimento do worker. Uma coluna no Postgres
 * também funcionaria, mas custaria uma consulta ao banco por iteração de tool,
 * no caminho mais quente do sistema.
 *
 * O pedido é um **recado**, não um comando: quem manda parar não interrompe
 * nada: ele deixa a chave e responde. Quem para de verdade é o próprio turno,
 * num ponto em que sabe o que está a meio caminho.
 */

const CHAVE = (runId: string) => `seahub:run:cancelar:${runId}`;

/**
 * Uma hora. O recado só interessa enquanto o turno pode estar vivo, e turno
 * nenhum dura isso — o TTL existe para a chave não sobreviver ao problema.
 */
export const VALIDADE_S = 3_600;

/** De quanto em quanto tempo o turno confere o recado durante a chamada ao modelo. */
export const INTERVALO_DE_VIGIA_MS = 2_000;

export class ExecucaoInterrompida extends Error {
  constructor(
    readonly runId: string,
    readonly porQuem: string,
  ) {
    super(`Execução interrompida no painel por ${porQuem}.`);
    this.name = "ExecucaoInterrompida";
  }
}

export function ehInterrupcao(erro: unknown): erro is ExecucaoInterrompida {
  return erro instanceof ExecucaoInterrompida;
}

/** Deixa o recado. Devolve `false` se o Redis não aceitou — a tela precisa saber. */
export async function pedirParada(
  runId: string,
  porQuem: string,
): Promise<boolean> {
  try {
    await getRedis().set(CHAVE(runId), porQuem || "alguém", "EX", VALIDADE_S);
    return true;
  } catch (erro) {
    logger.error({ runId, erro }, "não consegui registrar o pedido de parada");
    return false;
  }
}

/**
 * Quem pediu para parar, ou `null`.
 *
 * Engole falha do Redis de propósito: uma instabilidade na leitura do recado
 * não pode derrubar um atendimento em andamento. O pior caso vira "não parou",
 * que é o comportamento de antes desta funcionalidade existir.
 */
export async function paradaPedida(runId: string): Promise<string | null> {
  try {
    return await getRedis().get(CHAVE(runId));
  } catch {
    return null;
  }
}

/** Melhor esforço: recado que sobra expira sozinho pelo TTL. */
export async function limparPedido(runId: string): Promise<void> {
  try {
    await getRedis().del(CHAVE(runId));
  } catch {
    // O TTL resolve.
  }
}

/** Ponto de parada entre etapas do turno. */
export async function conferirParada(runId: string): Promise<void> {
  const quem = await paradaPedida(runId);
  if (quem) throw new ExecucaoInterrompida(runId, quem);
}

/**
 * Roda a chamada ao modelo podendo abortá-la no meio.
 *
 * Sem isto, "parar" só teria efeito **entre** iterações — e é dentro da chamada
 * ao modelo que o turno passa quase todo o tempo. Um turno pendurado, que é
 * justamente o que alguém quer matar, nunca chegaria ao próximo ponto de
 * parada.
 *
 * O erro devolvido é sempre `ExecucaoInterrompida`, nunca o `AbortError` cru:
 * quem trata precisa distinguir "mandaram parar" de "a rede caiu", e as duas
 * coisas chegariam como abort.
 */
export async function comParadaVigiada<T>(
  runId: string,
  executar: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controle = new AbortController();
  let quem: string | null = null;

  const vigia = setInterval(() => {
    void paradaPedida(runId).then((pedido) => {
      if (!pedido) return;
      quem = pedido;
      controle.abort();
    });
  }, INTERVALO_DE_VIGIA_MS);
  vigia.unref?.();

  try {
    return await executar(controle.signal);
  } catch (erro) {
    // Só vira interrupção se **nós** abortamos. Abort por outro motivo (timeout
    // do SDK, rede) continua sendo o erro que era.
    if (quem) throw new ExecucaoInterrompida(runId, quem);
    throw erro;
  } finally {
    clearInterval(vigia);
  }
}
