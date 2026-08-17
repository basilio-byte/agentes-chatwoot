import { logger } from "@/lib/logger";
import type { ChatwootClient } from "./client";

/**
 * Quem é **gente** na conta do Chatwoot.
 *
 * Existe porque o Chatwoot atribui o próprio Agent Bot à conversa em algumas
 * caixas, e a regra global lia isso como "um humano assumiu": o bot calava para
 * sempre, e a conversa resolvida nem reabria — reabrir exige não ter dono.
 * Conversa muda, sem erro nenhum, e invisível no painel, porque o bot também
 * não aparece no filtro de "Agente atribuído".
 *
 * A fonte da verdade é `GET /agents`: quem está lá é pessoa, quem não está não
 * é. Não depende do id do bot estar cadastrado no painel — campo opcional que
 * pode nunca ter sido preenchido.
 */

/**
 * Cinco minutos: a lista de agentes muda quando alguém entra ou sai da equipe,
 * o que é raro. O risco de uma lista velha é tratar um atendente recém-criado
 * como "não humano" — e é exatamente por isso que o caminho de "não achei" faz
 * uma releitura ao vivo antes de concluir (ver `ehHumano`).
 */
const TTL_MS = 5 * 60 * 1000;

const cache = new Map<number, { ids: Set<number>; expiraEm: number }>();

export function limparCacheDeHumanos() {
  cache.clear();
}

async function buscar(
  cliente: ChatwootClient,
  contaId: number,
): Promise<Set<number> | null> {
  try {
    const atendentes = await cliente.listarAtendentes();
    const ids = new Set(atendentes.map((a) => a.id));
    cache.set(contaId, { ids, expiraEm: Date.now() + TTL_MS });
    return ids;
  } catch (erro) {
    logger.warn(
      { conta: contaId, erro: erro instanceof Error ? erro.message : erro },
      "não consegui listar os agentes da conta — tratando o dono como humano",
    );
    return null;
  }
}

/**
 * O responsável desta conversa é uma pessoa?
 *
 * `null` quando não deu para saber — e aí quem chama **trata como pessoa**.
 * Falar por cima de um atendente de verdade é pior que ficar quieto.
 *
 * ⚠ Um "não" nunca sai do cache sozinho. Se o id não estiver na lista guardada,
 * a lista é relida **ao vivo** antes de concluir: sem isso, um atendente
 * contratado hoje seria classificado como não-humano por até cinco minutos, e o
 * bot falaria por cima dele. O custo extra só acontece no caso raro.
 */
export async function ehHumano(
  cliente: ChatwootClient,
  assigneeId: number | null | undefined,
): Promise<boolean | null> {
  if (assigneeId == null) return null;

  const contaId = cliente.contaId;
  const guardado = cache.get(contaId);

  if (guardado && guardado.expiraEm > Date.now() && guardado.ids.has(assigneeId)) {
    return true;
  }

  const ids = await buscar(cliente, contaId);
  if (!ids) return null;

  return ids.has(assigneeId);
}

/**
 * Resolve a humanidade do dono já no formato que `podeAgir` espera.
 *
 * Devolve `undefined` (e não `false`) quando não há dono ou quando não deu para
 * conferir: é o valor que faz a regra manter o comportamento conservador.
 */
export async function donoEhHumano(
  cliente: ChatwootClient,
  assigneeId: number | null | undefined,
): Promise<boolean | undefined> {
  const resultado = await ehHumano(cliente, assigneeId);
  return resultado ?? undefined;
}
