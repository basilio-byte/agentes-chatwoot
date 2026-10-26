import { timingSafeEqual } from "node:crypto";
import { gerarToken } from "@/server/gatilho/token";
import { hashDoToken } from "@/server/mcp/token";

/**
 * Token do coletor do servidor dos OpenClaws.
 *
 * Mesmo desenho do token do MCP: 256 bits, guardado só como hash (o banco que
 * vazar não entrega token), prefixo reconhecível para se achar quando for
 * colado no lugar errado. Vai no cabeçalho `Authorization`, nunca na URL — esta
 * rota é chamada por um script nosso, que pode mandar cabeçalho.
 */
export const PREFIXO_DO_COLETOR = "seahub_oc_";

export function novoTokenDoColetor(): { token: string; hash: string; dica: string } {
  const token = `${PREFIXO_DO_COLETOR}${gerarToken()}`;
  return { token, hash: hashDoToken(token), dica: `${PREFIXO_DO_COLETOR}…${token.slice(-4)}` };
}

/** Compara em tempo constante. Sem hash guardado, nada confere. */
export function tokenDoColetorConfere(
  apresentado: string | null | undefined,
  hashGuardado: string | null | undefined,
): boolean {
  if (!apresentado || !hashGuardado) return false;
  if (!apresentado.startsWith(PREFIXO_DO_COLETOR)) return false;
  const a = Buffer.from(hashDoToken(apresentado), "hex");
  const b = Buffer.from(hashGuardado, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
