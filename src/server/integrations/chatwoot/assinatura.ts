import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verificação da assinatura do webhook do Chatwoot.
 *
 * Cabeçalhos enviados por ele:
 *   X-Chatwoot-Signature  sha256=<hmac>
 *   X-Chatwoot-Timestamp  unix em segundos
 *   X-Chatwoot-Delivery   id único da entrega
 *
 * Assinatura = HMAC-SHA256(secret, "{timestamp}.{corpo_cru}")
 *
 * O corpo tem de ser o **texto cru** recebido. Reserializar o JSON muda os bytes
 * e a verificação passa a falhar sempre.
 */

export const TOLERANCIA_SEGUNDOS = 300; // 5 min contra replay

export type ResultadoVerificacao =
  | { ok: true }
  | { ok: false; motivo: string };

export function verificarAssinatura(args: {
  corpoCru: string;
  assinatura: string | null;
  timestamp: string | null;
  secret: string;
  /** Injetável para teste. */
  agoraEmSegundos?: number;
}): ResultadoVerificacao {
  const { corpoCru, assinatura, timestamp, secret } = args;

  if (!secret) return { ok: false, motivo: "secret do webhook não configurado" };
  if (!assinatura) return { ok: false, motivo: "sem X-Chatwoot-Signature" };
  if (!timestamp) return { ok: false, motivo: "sem X-Chatwoot-Timestamp" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, motivo: "timestamp inválido" };
  }

  const agora = args.agoraEmSegundos ?? Math.floor(Date.now() / 1000);
  if (Math.abs(agora - ts) > TOLERANCIA_SEGUNDOS) {
    return { ok: false, motivo: "timestamp fora da janela de tolerância" };
  }

  const esperado = assinar(secret, timestamp, corpoCru);

  // Comparação em tempo constante — comparar com === vaza o prefixo correto.
  const a = Buffer.from(esperado);
  const b = Buffer.from(assinatura);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, motivo: "assinatura não confere" };
  }

  return { ok: true };
}

export function assinar(secret: string, timestamp: string, corpoCru: string) {
  const hmac = createHmac("sha256", secret)
    .update(`${timestamp}.${corpoCru}`)
    .digest("hex");
  return `sha256=${hmac}`;
}
