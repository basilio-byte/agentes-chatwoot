import { getRedis } from "@/server/queue/conexao";
import { extrairRecursoChave } from "./payload";

/**
 * Duas guardas, propósitos diferentes — mesmo espírito de
 * `src/server/agents/travas.ts` (constantes comentadas, cada uma pega uma
 * patologia diferente, sempre resolve escalando/registrando em vez de falhar
 * em silêncio), mas com estado persistente entre execuções (Redis), porque o
 * "laço" aqui é entre jobs SEPARADOS, não entre saltos dentro de um turno.
 *
 * - Cooldown por recurso pega a causa raiz: o agente muda a MESMA tarefa que
 *   disparou o gatilho, o provedor externo reage e chama de volta para o
 *   mesmo recurso. Curto, silencioso, sem exigir ninguém olhar.
 * - Teto global por agente é a rede de segurança para o que o cooldown não
 *   cobre: laço entre recursos DIFERENTES, payload sem id extraível, ou
 *   volume de um sistema mal configurado. Por ser o último recurso, age
 *   forte — quem chama desliga o gatilho — e deixa rastro no Postgres, não
 *   só no log do container.
 */
export const COOLDOWN_POR_RECURSO_S = 20;
export const TETO_DE_EXECUCOES_NA_JANELA = 40;
export const JANELA_DO_TETO_S = 10 * 60;

export type VereditoDoGatilho =
  | { pode: true }
  | { pode: false; motivo: "cooldown_do_recurso" }
  | { pode: false; motivo: "teto_de_execucoes"; execucoesNaJanela: number };

const CHAVE_COOLDOWN = (agentId: string, recursoChave: string) =>
  `gatilho:cooldown:${agentId}:${recursoChave}`;

const CHAVE_JANELA = (agentId: string) => `gatilho:janela:${agentId}`;

/**
 * Consome o cooldown e incrementa a janela — só chamar quando a chamada VAI
 * de fato rodar o agente (gatilho desligado nem chega aqui). Precisa
 * acontecer antes de agendar o job, não dentro do worker: se ficasse só lá
 * (assíncrono), o disparo rápido que esta trava existe para pegar já teria
 * passado.
 */
export async function avaliarGatilho(
  agentId: string,
  payload: unknown,
): Promise<VereditoDoGatilho> {
  const redis = getRedis();

  const recursoChave = extrairRecursoChave(payload);
  if (recursoChave) {
    // SET ... NX EX: só grava se a chave não existir. Se gravou, é a primeira
    // chamada para este recurso na janela — segue. Se não gravou (já existia),
    // é a segunda chamada dentro do cooldown — barra.
    //
    // Deliberadamente NÃO inclui o eventType na chave: um `taskUpdated`
    // (gatilho original) seguido de `taskCommentPosted` (efeito colateral da
    // própria tool) precisa cair na MESMA chave, senão a trava não pega
    // justo o caso para o qual ela existe.
    const gravou = await redis.set(
      CHAVE_COOLDOWN(agentId, recursoChave),
      "1",
      "EX",
      COOLDOWN_POR_RECURSO_S,
      "NX",
    );
    if (gravou !== "OK") {
      return { pode: false, motivo: "cooldown_do_recurso" };
    }
  }

  const chaveJanela = CHAVE_JANELA(agentId);
  const execucoes = await redis.incr(chaveJanela);
  if (execucoes === 1) {
    await redis.expire(chaveJanela, JANELA_DO_TETO_S);
  }

  if (execucoes > TETO_DE_EXECUCOES_NA_JANELA) {
    return {
      pode: false,
      motivo: "teto_de_execucoes",
      execucoesNaJanela: execucoes,
    };
  }

  return { pode: true };
}
