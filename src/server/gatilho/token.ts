import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Token do gatilho HTTP — o único segredo deste projeto que nasce do NOSSO
 * lado, em vez de vir colado de um sistema externo. Vai no path da URL
 * (`/api/webhooks/gatilho/<agentId>/<token>`), não em header: nem toda API que
 * dispara webhook deixa configurar cabeçalho customizado (o ClickUp, por
 * exemplo, não deixa — só a URL é configurável).
 *
 * 256 bits de entropia em base64url (sem `/`, `+` nem `=`) — seguro como
 * segmento de URL sem encoding extra, e a entropia por si só torna
 * brute-force inviável, sem precisar de rate-limit dedicado a essa frente.
 */
const BYTES_DE_ENTROPIA = 32;

export function gerarToken(): string {
  return randomBytes(BYTES_DE_ENTROPIA).toString("base64url");
}

/**
 * Compara em tempo constante — comparar com `===` vaza o prefixo correto por
 * quanto tempo a comparação leva para falhar.
 */
export function tokenConfere(apresentado: string, esperado: string): boolean {
  const a = Buffer.from(apresentado);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
