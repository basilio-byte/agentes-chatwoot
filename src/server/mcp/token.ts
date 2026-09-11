import { createHash } from "node:crypto";
import { gerarToken } from "@/server/gatilho/token";

/**
 * Token pessoal do MCP.
 *
 * Mesma entropia do token do gatilho (256 bits, `gerarToken`), com duas
 * diferenças deliberadas:
 *
 * - **Prefixo `seahub_mcp_`.** Um token colado num lugar errado (chat, ticket,
 *   repositório) precisa ser reconhecível à primeira vista — por gente e por
 *   ferramenta de varredura de segredo.
 * - **Guardado como hash, não cifrado.** O do gatilho é cifrado porque é
 *   conferido contra UM agente conhecido pela URL. Este é procurado entre todos
 *   os tokens de todas as pessoas, e a busca é pelo hash. E ele nunca precisa
 *   ser lido de volta: o banco que vazar não entrega token nenhum.
 *
 * Hash sem sal basta: sal existe para proteger segredo FRACO (senha escolhida
 * por gente) contra dicionário. 256 bits aleatórios não têm dicionário.
 */
export const PREFIXO_DO_TOKEN = "seahub_mcp_";

export function hashDoToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** O que a tela mostra para a pessoa reconhecer o token sem revelá-lo. */
export function dicaDoToken(token: string): string {
  return `${PREFIXO_DO_TOKEN}…${token.slice(-4)}`;
}

export function novoTokenMcp(): { token: string; hash: string; hint: string } {
  const token = `${PREFIXO_DO_TOKEN}${gerarToken()}`;
  return { token, hash: hashDoToken(token), hint: dicaDoToken(token) };
}

/**
 * `Authorization: Bearer <token>` → token. Qualquer outra forma → `null`.
 *
 * Só aceita o esquema Bearer: token no corpo ou na URL vazaria em log de
 * proxy e em histórico de navegador.
 */
export function extrairBearer(cabecalho: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(cabecalho ?? "");
  return m ? m[1] : null;
}

/** Filtro barato antes de ir ao banco: não gasta consulta com lixo. */
export function pareceTokenMcp(texto: string): boolean {
  return texto.startsWith(PREFIXO_DO_TOKEN) && texto.length >= PREFIXO_DO_TOKEN.length + 40;
}
