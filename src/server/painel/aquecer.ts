import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@/lib/logger";
import { agoraEmSaoPaulo } from "@/lib/tempo";

/**
 * O worker pede ao painel, de dentro do container, para aquecer as leituras
 * externas das telas (`leituras-remotas.ts`).
 *
 * Por que passa pelo HTTP, e não por um import: o worker é um processo à parte
 * (`node worker.mjs &`, no mesmo container), e o guardador mora na memória do
 * processo do painel. O pedido é o único jeito de encher o guardador de quem
 * atende as telas — e é a ponte mais curta: a rota roda exatamente o código que a
 * tela roda.
 *
 * - **Token derivado da AUTH_SECRET** (HMAC): os dois processos têm o mesmo
 *   ambiente, então não há segredo novo para cadastrar nem para vazar. A rota
 *   responde 404 a quem não o tem.
 * - **Só em horário de uso** (6h às 22h de São Paulo): de madrugada ninguém abre a
 *   tela, e a primeira abertura da manhã encontra tudo quente porque o primeiro
 *   pedido das 6h enche o guardador.
 * - **A cada 4 minutos no máximo**, e só conta como feito quando a rota respondeu
 *   bem: o painel ainda subindo (logo depois do deploy) faz o pedido falhar, e o
 *   minuto seguinte tenta de novo.
 * - ⚠ Nunca derruba o vigia: não espera a resposta e engole qualquer erro.
 */

const A_CADA_MS = 4 * 60_000;

export function tokenDoAquecimento(segredo: string | undefined = process.env.AUTH_SECRET): string | null {
  if (!segredo) return null;
  return createHmac("sha256", segredo).update("aquecer-o-painel").digest("hex");
}

export function tokenDoAquecimentoConfere(
  apresentado: string | null | undefined,
  segredo: string | undefined = process.env.AUTH_SECRET,
): boolean {
  const esperado = tokenDoAquecimento(segredo);
  if (!esperado || !apresentado) return false;
  const a = Buffer.from(apresentado);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 6h às 22h em São Paulo — o container roda em UTC, e a hora de uso é a daqui. */
export function emHorarioDeAquecer(agora = new Date()): boolean {
  const hora = Number(agoraEmSaoPaulo(agora).hora.slice(0, 2));
  return hora >= 6 && hora < 22;
}

let ultimoPedidoBemFeito = 0;
let pedindo = false;
let recusasSeguidas = 0;

/** Logo depois do deploy o painel ainda não atende: tenta de novo em segundos, e não só no minuto seguinte do vigia. */
const REPETIR_ATE = 6;
const REPETIR_EM_MS = 10_000;

/** Só para teste: esquece o relógio entre um caso e outro. */
export function reiniciarRelogioDoAquecimento() {
  ultimoPedidoBemFeito = 0;
  pedindo = false;
  recusasSeguidas = 0;
}

export type DependenciasDoPedido = {
  agora?: number;
  buscar?: typeof fetch;
  porta?: string;
  segredo?: string;
  /** `null` desliga a repetição (teste). */
  repetirEmMs?: number | null;
};

/** Devolve `true` se um pedido saiu agora (não quer dizer que deu certo). */
export function pedirAquecimentoDoPainel(opcoes: DependenciasDoPedido = {}): boolean {
  const agora = opcoes.agora ?? Date.now();
  if (pedindo || agora - ultimoPedidoBemFeito < A_CADA_MS) return false;
  if (!emHorarioDeAquecer(new Date(agora))) return false;

  const token = tokenDoAquecimento(opcoes.segredo ?? process.env.AUTH_SECRET);
  if (!token) return false;

  pedindo = true;
  const buscar = opcoes.buscar ?? fetch;
  const porta = opcoes.porta ?? process.env.PORT ?? "3000";

  void buscar(`http://127.0.0.1:${porta}/api/interno/aquecer`, {
    method: "POST",
    headers: { "x-aquecer": token },
    signal: AbortSignal.timeout(90_000),
  })
    .then(async (resposta) => {
      if (resposta.ok) {
        ultimoPedidoBemFeito = agora;
        recusasSeguidas = 0;
        logger.info(await resposta.json().catch(() => ({})), "painel aquecido");
      } else {
        logger.warn({ status: resposta.status }, "painel: o pedido de aquecimento foi recusado");
      }
    })
    .catch((erro: unknown) => {
      // O painel ainda subindo recusa a conexão: normal logo depois do deploy.
      logger.debug({ erro: erro instanceof Error ? erro.message : String(erro) }, "painel: aquecimento adiado");
      const repetirEm = opcoes.repetirEmMs === undefined ? REPETIR_EM_MS : opcoes.repetirEmMs;
      if (repetirEm !== null && recusasSeguidas++ < REPETIR_ATE) {
        const timer = setTimeout(() => pedirAquecimentoDoPainel(opcoes), repetirEm);
        timer.unref?.();
      }
    })
    .finally(() => {
      pedindo = false;
    });
  return true;
}
