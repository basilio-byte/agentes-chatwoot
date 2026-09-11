"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigirSessao } from "@/server/auth-guard";
import { UserRole } from "@/generated/prisma/enums";
import { novoTokenMcp } from "@/server/mcp/token";

// ⚠ Arquivo "use server": só função assíncrona e tipo podem ser exportados
// (ver `use-server.test.ts`). O teto abaixo fica sem `export` por isso.
const TOKENS_ATIVOS_POR_PESSOA = 10;

export type EstadoTokenMcp = {
  ok?: string;
  erro?: string;
  /** Texto puro do token recém-gerado. Só existe nesta resposta. */
  token?: string;
  camposComErro?: Record<string, string>;
};

/**
 * Gera um token pessoal do MCP e o devolve em texto puro — a única vez.
 *
 * Qualquer papel gera: o token não dá a ninguém mais do que a conta já tem, e o
 * papel é relido a cada chamada. Um token de Leitura só consulta.
 */
export async function gerarTokenMcp(
  _estado: EstadoTokenMcp,
  formData: FormData,
): Promise<EstadoTokenMcp> {
  const sessao = await exigirSessao();

  const nome = String(formData.get("nome") ?? "").trim();
  if (nome.length < 2 || nome.length > 60) {
    return {
      erro: "Confira os campos.",
      camposComErro: {
        nome: "Dê um nome de 2 a 60 caracteres — é por ele que você vai saber qual revogar.",
      },
    };
  }

  const ativos = await db.mcpToken.count({
    where: { userId: sessao.user.id, revokedAt: null },
  });
  if (ativos >= TOKENS_ATIVOS_POR_PESSOA) {
    return {
      erro: `Você já tem ${ativos} tokens ativos. Revogue um que não usa mais antes de gerar outro.`,
    };
  }

  const { token, hash, hint } = novoTokenMcp();
  const criado = await db.mcpToken.create({
    data: { userId: sessao.user.id, nome, tokenHash: hash, hint },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "mcp.token.created",
      entity: "McpToken",
      entityId: criado.id,
    },
  });

  revalidatePath("/acesso-mcp");
  return { ok: "Token gerado. Copie agora — ele não aparece de novo.", token };
}

/**
 * Revoga um token. Cada pessoa revoga os seus; o Proprietário revoga o de
 * qualquer um — é o que se faz no dia em que alguém sai da empresa.
 */
export async function revogarTokenMcp(id: string): Promise<EstadoTokenMcp> {
  const sessao = await exigirSessao();

  const registro = await db.mcpToken.findUnique({
    where: { id },
    select: { userId: true, revokedAt: true },
  });
  if (!registro) return { erro: "Token não encontrado." };

  const ehDono = registro.userId === sessao.user.id;
  if (!ehDono && sessao.user.role !== UserRole.OWNER) {
    return { erro: "Só o dono do token ou um Proprietário pode revogá-lo." };
  }
  if (registro.revokedAt) return { ok: "Este token já estava revogado." };

  await db.mcpToken.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "mcp.token.revoked",
      entity: "McpToken",
      entityId: id,
    },
  });

  revalidatePath("/acesso-mcp");
  return {
    ok: "Token revogado. Quem o estiver usando perde o acesso na próxima chamada.",
  };
}
