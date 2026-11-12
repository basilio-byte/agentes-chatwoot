"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { SituacaoDaLacuna, UserRole } from "@/generated/prisma/enums";
import { exigirPapel } from "@/server/auth-guard";
import { comFalhaVisivel } from "@/server/actions/falha-visivel";
import { autorDaSessao, auditar } from "@/server/gestao/autor";
import { validarResolucao } from "@/server/lacunas/regras";

export type EstadoDaLacuna = { ok?: string; erro?: string };

// ⚠ Só função assíncrona pode ser exportada daqui — `use-server.test.ts` cobra.

/**
 * Resolve uma lacuna: ela sai da fila e vai para o Histórico, com o que foi
 * feito, quem fez e quando. Administrador para cima: é a lista de trabalho de
 * quem melhora os agentes, e resolver tira a linha da vista de todo mundo.
 *
 * Pedido do Diego (12/11/2026): antes a linha era APAGADA e sumia sem rastro.
 * Agora o comentário é obrigatório e a exclusão não existe mais — quem lê o
 * Histórico depois vê o que foi fornecido ao agente e em que dia.
 *
 * Uma por vez, de propósito: o comentário é de cada lacuna ("acrescentei o
 * procedimento X ao prompt"), e um texto só para várias seria o "ok" que o
 * Histórico existe para evitar.
 *
 * ⚠ A troca é UM `updateMany` condicionado a `ABERTA`: duas pessoas clicando ao
 * mesmo tempo não sobrescrevem o comentário uma da outra — quem chega depois
 * recebe o aviso.
 */
export async function resolverLacuna(
  id: string,
  resolucao: string,
): Promise<EstadoDaLacuna> {
  return comFalhaVisivel<EstadoDaLacuna>(
    "lacunas.resolver",
    async () => {
      const sessao = await exigirPapel(UserRole.ADMIN);

      if (typeof id !== "string" || !id) return { erro: "Lacuna não encontrada." };
      const conferido = validarResolucao(resolucao);
      if (!conferido.ok) return { erro: conferido.erro };

      const lacuna = await db.lacunaDoAgente.findUnique({
        where: { id },
        select: { agentId: true },
      });
      if (!lacuna) return { erro: "Essa lacuna não existe mais." };

      const autor = autorDaSessao(sessao);
      const { count } = await db.lacunaDoAgente.updateMany({
        where: { id, situacao: SituacaoDaLacuna.ABERTA },
        data: {
          situacao: SituacaoDaLacuna.RESOLVIDA,
          resolvidaEm: new Date(),
          resolvidaPorId: autor.userId,
          resolvidaPorNome: autor.nome,
          resolucao: conferido.texto,
        },
      });
      if (count === 0) {
        revalidatePath("/lacunas");
        return { erro: "Outra pessoa já resolveu esta lacuna. Atualize a página." };
      }

      // O comentário mora na própria linha; a auditoria diz só quem e de qual
      // agente (o texto é dado de trabalho e não precisa ficar duas vezes).
      await auditar(autor, "lacuna.resolved", "LacunaDoAgente", id, {
        agentId: lacuna.agentId,
      });

      revalidatePath("/lacunas");
      return { ok: "Lacuna resolvida. Ela foi para o Histórico." };
    },
    (falha) => ({ erro: falha.erro }),
  );
}

/**
 * Devolve uma lacuna do Histórico para a fila.
 *
 * Existe porque a exclusão saiu: resolver por engano, ou resolver e descobrir
 * depois que não resolveu, não pode ser um beco sem saída. O comentário e as
 * datas anteriores deixam a linha, mas ficam na auditoria (`resolucaoAnterior`,
 * `resolvidaPor`, `resolvidaEm`) — reabrir não apaga a história de ninguém.
 */
export async function reabrirLacuna(id: string): Promise<EstadoDaLacuna> {
  return comFalhaVisivel<EstadoDaLacuna>(
    "lacunas.reabrir",
    async () => {
      const sessao = await exigirPapel(UserRole.ADMIN);
      if (typeof id !== "string" || !id) return { erro: "Lacuna não encontrada." };

      const lacuna = await db.lacunaDoAgente.findUnique({
        where: { id },
        select: {
          agentId: true,
          situacao: true,
          resolvidaEm: true,
          resolvidaPorNome: true,
          resolucao: true,
        },
      });
      if (!lacuna) return { erro: "Essa lacuna não existe mais." };

      const { count } = await db.lacunaDoAgente.updateMany({
        where: { id, situacao: SituacaoDaLacuna.RESOLVIDA },
        data: {
          situacao: SituacaoDaLacuna.ABERTA,
          resolvidaEm: null,
          resolvidaPorId: null,
          resolvidaPorNome: null,
          resolucao: null,
        },
      });
      if (count === 0) {
        revalidatePath("/lacunas");
        return { erro: "Esta lacuna já voltou para a fila. Atualize a página." };
      }

      await auditar(autorDaSessao(sessao), "lacuna.reopened", "LacunaDoAgente", id, {
        agentId: lacuna.agentId,
        resolvidaPor: lacuna.resolvidaPorNome,
        resolvidaEm: lacuna.resolvidaEm?.toISOString() ?? null,
        resolucaoAnterior: lacuna.resolucao,
      });

      revalidatePath("/lacunas");
      return { ok: "Lacuna reaberta. Ela voltou para a fila." };
    },
    (falha) => ({ erro: falha.erro }),
  );
}
