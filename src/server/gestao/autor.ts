import { db } from "@/lib/db";

/**
 * Quem faz a alteração, e por onde ela entrou.
 *
 * As funções de `server/gestao/` são chamadas por duas portas — as server
 * actions do painel e as ferramentas do MCP — e é isto que as deixa iguais
 * para as duas. A regra de negócio ("arquivado não liga", "restaurar devolve
 * desligado", "prompt novo cria versão") mora uma vez só; cada porta confere o
 * papel do seu jeito e traduz o resultado para a sua tela.
 *
 * ⚠ Copiar a regra para a ferramenta do MCP seria mais rápido e é exatamente o
 * erro que este projeto já pagou: capacidade duplicada é a que diverge.
 */
export type Autor = {
  userId: string;
  /** Para as frases que nomeiam alguém ("encerrada por Fulana"). */
  nome: string;
  /** Presente quando a alteração veio de um assistente, pelo MCP. */
  mcp?: { tokenId: string };
};

/**
 * Resultado de uma operação de gestão. `aviso` acompanha um sucesso que tem
 * consequência que a pessoa precisa saber ("é a entrada, mas está desligado").
 */
export type Desfecho = { ok: string; aviso?: string } | { erro: string };

type ValorDeAuditoria = string | number | boolean | null | string[] | number[];

export function autorDaSessao(sessao: {
  user: { id: string; name?: string | null; email?: string | null };
}): Autor {
  return {
    userId: sessao.user.id,
    nome: sessao.user.name || sessao.user.email || "painel",
  };
}

/**
 * Grava a auditoria.
 *
 * Pelo MCP, o `diff` sempre carrega `via: "mcp"` e o id do token. Sem isso uma
 * alteração feita por um assistente seria indistinguível de uma feita à mão
 * pela mesma pessoa — e "de onde veio isso" é a primeira pergunta quando um
 * agente muda de comportamento sem ninguém lembrar de ter mexido.
 */
export async function auditar(
  autor: Autor,
  action: string,
  entity: string,
  entityId: string,
  detalhe?: Record<string, ValorDeAuditoria>,
) {
  const diff = autor.mcp
    ? { via: "mcp", tokenId: autor.mcp.tokenId, ...detalhe }
    : detalhe;

  await db.auditLog.create({
    data: {
      userId: autor.userId,
      action,
      entity,
      entityId,
      ...(diff ? { diff } : {}),
    },
  });
}
