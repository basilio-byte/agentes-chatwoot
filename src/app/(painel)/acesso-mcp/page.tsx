import { headers } from "next/headers";
import { db } from "@/lib/db";
import { exigirSessao, podeEditar } from "@/server/auth-guard";
import { UserRole } from "@/generated/prisma/enums";
import { AcessoMcp } from "@/components/acesso-mcp";
import { PageHeader } from "@/components/ui";
import { rotuloDoPapel } from "@/lib/papeis";

export const dynamic = "force-dynamic";

export default async function AcessoMcpPage() {
  const sessao = await exigirSessao();
  const souOwner = sessao.user.role === UserRole.OWNER;

  // Mesma montagem da URL pública da tela do agente: funciona em local e atrás
  // do proxy do Easypanel sem variável de ambiente.
  const cabecalhos = await headers();
  const protocolo = cabecalhos.get("x-forwarded-proto") ?? "https";
  const host = cabecalhos.get("host") ?? "localhost:3000";

  const tokens = await db.mcpToken.findMany({
    where: souOwner ? {} : { userId: sessao.user.id },
    orderBy: [{ revokedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
    select: {
      id: true,
      nome: true,
      hint: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
      user: { select: { id: true, name: true } },
    },
  });

  return (
    <>
      <PageHeader
        titulo="Acesso MCP"
        descricao="Conecte um assistente de I.A. (Claude Code, Claude Desktop, Cursor…) a este painel. Ele consulta e opera os agentes com o poder da sua conta — nem mais, nem menos."
      />

      <AcessoMcp
        url={`${protocolo}://${host}/api/mcp`}
        meuId={sessao.user.id}
        rotuloDoPapel={rotuloDoPapel(sessao.user.role)}
        podeAlterar={podeEditar(sessao.user.role)}
        souOwner={souOwner}
        tokens={tokens.map((t) => ({
          id: t.id,
          nome: t.nome,
          hint: t.hint,
          criadoEm: t.createdAt,
          usadoEm: t.lastUsedAt,
          revogadoEm: t.revokedAt,
          dono: { id: t.user.id, nome: t.user.name },
        }))}
      />
    </>
  );
}
