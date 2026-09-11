import { db } from "@/lib/db";
import type { UserRole } from "@/generated/prisma/enums";
import { extrairBearer, hashDoToken, pareceTokenMcp } from "./token";

export type AcessoMcp = {
  tokenId: string;
  usuario: { id: string; nome: string; email: string; papel: UserRole };
};

/** Gravar `lastUsedAt` a cada chamada seria uma escrita por leitura. */
const INTERVALO_DE_REGISTRO_DE_USO_MS = 60_000;

/**
 * Quem está chamando, a partir do cabeçalho `Authorization`.
 *
 * `null` para qualquer recusa — ausente, malformado, desconhecido, revogado ou
 * de conta desativada — sem dizer qual. Quem tenta adivinhar token não precisa
 * saber que acertou um revogado.
 *
 * ⚠ O papel vem da CONTA, relido a cada requisição. Guardá-lo no token faria
 * "rebaixei fulano a Leitura" não valer para o assistente dele até alguém
 * lembrar de revogar.
 */
export async function autenticarMcp(
  cabecalho: string | null,
): Promise<AcessoMcp | null> {
  const token = extrairBearer(cabecalho);
  if (!token || !pareceTokenMcp(token)) return null;

  const registro = await db.mcpToken.findUnique({
    where: { tokenHash: hashDoToken(token) },
    select: {
      id: true,
      revokedAt: true,
      lastUsedAt: true,
      user: {
        select: { id: true, name: true, email: true, role: true, active: true },
      },
    },
  });

  if (!registro || registro.revokedAt || !registro.user.active) return null;

  const usadoHaMuito =
    !registro.lastUsedAt ||
    Date.now() - registro.lastUsedAt.getTime() > INTERVALO_DE_REGISTRO_DE_USO_MS;
  if (usadoHaMuito) {
    // Sem esperar: registrar uso não pode atrasar nem derrubar a chamada.
    void db.mcpToken
      .update({ where: { id: registro.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
  }

  return {
    tokenId: registro.id,
    usuario: {
      id: registro.user.id,
      nome: registro.user.name,
      email: registro.user.email,
      papel: registro.user.role,
    },
  };
}
