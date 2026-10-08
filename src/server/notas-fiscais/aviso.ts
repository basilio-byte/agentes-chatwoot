import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { conferirUmaCobranca, type CobrancaDoAviso } from "./conferir";
import { emitirNotasFiscais, type RodadaDeEmissao } from "./emissao/emitir";

/**
 * O aviso do Conexa: a nota sai na hora do pagamento, não até 35 min depois.
 *
 * ⚠ **O corpo do aviso NÃO é fonte de dado.** O fluxo do n8n lia valor e
 * produtos do próprio corpo, e quem descobrisse o endereço podia mandar a nota
 * que quisesse. Aqui só o número da cobrança é aproveitado: o resto vem da API
 * do Conexa, relida na hora (`conferirUmaCobranca`). Um número inventado, no
 * pior caso, faz o sistema reler uma cobrança que existe — e as regras de
 * sempre (corte, cautela, reserva antes de enviar) decidem se emite.
 *
 * A rodada de 30 minutos continua: aviso que se perde, ou que chega antes de a
 * API mostrar o pagamento, vira nota por ali, só com atraso.
 */

/** O token vai no endereço; guardamos só o hash, como o do MCP. */
export function hashDoToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Compara em tempo constante. Sem hash guardado, nada confere. */
export function tokenDoAvisoConfere(apresentado: string, hashGuardado: string | null | undefined): boolean {
  if (!hashGuardado || !apresentado) return false;
  const a = Buffer.from(hashDoToken(apresentado), "hex");
  const b = Buffer.from(hashGuardado, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** O número da cobrança no corpo do aviso (`chargeId`; `id` por garantia), ou `null`. */
export function idDaCobrancaNoAviso(corpo: unknown): number | null {
  if (!corpo || typeof corpo !== "object") return null;
  const c = corpo as Record<string, unknown>;
  const bruto = c.chargeId ?? c.id;
  const n = typeof bruto === "string" && /^\d+$/.test(bruto) ? Number(bruto) : bruto;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** O aviso diz que a cobrança foi paga? Só para decidir se vale insistir. */
export function avisoDizQueFoiPaga(corpo: unknown): boolean {
  if (!corpo || typeof corpo !== "object") return false;
  const c = corpo as Record<string, unknown>;
  return c.status === "paid" || (typeof c.paymentDate === "string" && c.paymentDate.length > 0);
}

export type DesfechoDoAviso = {
  resultado: "emitida" | "registrada" | "ignorado" | "falhou";
  detalhe: string;
};

export type DependenciasDoAviso = {
  conferir: (cobrancaId: number) => Promise<CobrancaDoAviso>;
  emitir: () => Promise<RodadaDeEmissao>;
  /** O que ficou gravado para a cobrança depois da emissão. */
  notasDaCobranca: (cobrancaId: number) => Promise<Array<{ situacao: string; numero: number | null }>>;
  pausar: (ms: number) => Promise<void>;
  agora: () => number;
};

/** Mesmo aviso repetido em menos de um minuto: o Conexa reenvia, e a segunda leitura seria à toa. */
const JANELA_DE_REPETICAO_MS = 60_000;
const recentes = new Map<number, number>();

/** O aviso chega antes de a API mostrar o pagamento: espera um pouco e olha de novo. */
const ESPERAS_PELO_PAGAMENTO_MS = [15_000, 30_000];
const ESPERA_DA_EMISSAO_MS = 5_000;
const TENTATIVAS_DE_EMISSAO = 4;

export async function processarAviso(
  cobrancaId: number,
  opcoes: { esperavaPaga?: boolean; dependencias?: Partial<DependenciasDoAviso> } = {},
): Promise<DesfechoDoAviso> {
  const dep: DependenciasDoAviso = {
    conferir: (id) => conferirUmaCobranca(id),
    emitir: () => emitirNotasFiscais(new Date(), { forcar: true }),
    notasDaCobranca: notasDaCobrancaNoBanco,
    pausar: (ms) => new Promise((ok) => setTimeout(ok, ms)),
    agora: () => Date.now(),
    ...opcoes.dependencias,
  };

  const visto = recentes.get(cobrancaId);
  if (visto !== undefined && dep.agora() - visto < JANELA_DE_REPETICAO_MS) {
    return { resultado: "ignorado", detalhe: "aviso repetido há menos de 1 minuto" };
  }
  recentes.set(cobrancaId, dep.agora());
  if (recentes.size > 500) {
    for (const [id, quando] of recentes) if (dep.agora() - quando > JANELA_DE_REPETICAO_MS) recentes.delete(id);
  }

  try {
    let lida = await dep.conferir(cobrancaId);
    // O aviso diz "paga" e a API ainda não: insiste um pouco antes de deixar para o relógio.
    for (const espera of ESPERAS_PELO_PAGAMENTO_MS) {
      if (!(opcoes.esperavaPaga && lida.acao === "ignorada" && lida.naoPaga)) break;
      await dep.pausar(espera);
      lida = await dep.conferir(cobrancaId);
    }

    if (lida.acao === "ja vista") {
      // Já registrada (pela rodada de 30 min): a emissão pode não ter rodado ainda.
      return await emitirEContar(dep, cobrancaId, lida.detalhe);
    }
    if (lida.acao !== "gravada") {
      recentes.delete(cobrancaId);
      return {
        resultado: lida.acao === "falhou" ? "falhou" : "ignorado",
        detalhe: lida.detalhe,
      };
    }
    if (lida.situacao !== "PRONTA") {
      return { resultado: "registrada", detalhe: `registrada como ${lida.situacao}: ${lida.detalhe}` };
    }
    return await emitirEContar(dep, cobrancaId, "registrada e pronta");
  } catch (erro) {
    logger.error({ cobrancaId, erro: erro instanceof Error ? erro.message : String(erro) }, "aviso do Conexa: falhou");
    recentes.delete(cobrancaId);
    return { resultado: "falhou", detalhe: erro instanceof Error ? erro.message.slice(0, 200) : "erro" };
  }
}

/** Roda a emissão agora (esperando a rodada em andamento, se houver) e diz o que saiu. */
async function emitirEContar(dep: DependenciasDoAviso, cobrancaId: number, antes: string): Promise<DesfechoDoAviso> {
  let rodada: RodadaDeEmissao | null = null;
  for (let i = 0; i < TENTATIVAS_DE_EMISSAO; i++) {
    rodada = await dep.emitir();
    if (rodada.acao !== "em andamento") break;
    await dep.pausar(ESPERA_DA_EMISSAO_MS);
  }
  const notas = await dep.notasDaCobranca(cobrancaId);
  if (notas.length) {
    const quais = notas.map((n) => `${n.situacao.toLowerCase()}${n.numero ? ` nº ${n.numero}` : ""}`).join(", ");
    return { resultado: "emitida", detalhe: `${antes}; nota(s): ${quais}` };
  }
  if (rodada?.pausada) return { resultado: "registrada", detalhe: `${antes}; emissão desligada: ${rodada.pausada}` };
  if (rodada?.aguardando) return { resultado: "registrada", detalhe: `${antes}; aguardando a nota anterior (cautela)` };
  return { resultado: "registrada", detalhe: `${antes}; a emissão não enviou nota (travas, corte ou emissão desligada)` };
}

async function notasDaCobrancaNoBanco(cobrancaId: number) {
  return db.notaFiscalEmitida.findMany({
    where: { cobrancaId },
    select: { situacao: true, numero: true },
  });
}

/** Só para teste. */
export function esquecerAvisosRecentes() {
  recentes.clear();
}
