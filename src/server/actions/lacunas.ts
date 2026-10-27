"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { UserRole } from "@/generated/prisma/enums";
import { exigirPapel } from "@/server/auth-guard";
import { comFalhaVisivel } from "@/server/actions/falha-visivel";
import { autorDaSessao, auditar } from "@/server/gestao/autor";

export type EstadoDaLacuna = { ok?: string; erro?: string };

// ⚠ Só função assíncrona pode ser exportada daqui — o teto de uma remoção em
// lote mora na própria função, e `use-server.test.ts` cobra o resto.

/**
 * Apaga lacunas já tratadas. Administrador para cima: o relatório é a lista de
 * trabalho da equipe, e apagar tira uma linha da vista de todo mundo.
 *
 * Recebe IDS, nunca um filtro: o que a pessoa viu na tela é o que some. "Apagar
 * tudo do agente X" escrito como filtro levaria também as lacunas que chegaram
 * entre o carregamento da tela e o clique — registros que ninguém leu.
 *
 * A auditoria guarda quantas e de quais agentes, não o texto: o relatório é
 * dado de trabalho, e o que foi lido e resolvido não precisa ficar duas vezes.
 */
export async function apagarLacunas(ids: string[]): Promise<EstadoDaLacuna> {
  return comFalhaVisivel<EstadoDaLacuna>(
    "lacunas.apagar",
    async () => {
      const sessao = await exigirPapel(UserRole.ADMIN);

      const unicos = [...new Set(ids.filter((id) => typeof id === "string" && id))];
      if (unicos.length === 0) return { erro: "Nenhuma lacuna selecionada." };
      if (unicos.length > 200) {
        return { erro: "Apague no máximo 200 de cada vez." };
      }

      const existentes = await db.lacunaDoAgente.findMany({
        where: { id: { in: unicos } },
        select: { id: true, agentId: true },
      });

      const { count } = await db.lacunaDoAgente.deleteMany({
        where: { id: { in: existentes.map((l) => l.id) } },
      });

      if (count > 0) {
        await auditar(autorDaSessao(sessao), "lacuna.deleted", "LacunaDoAgente", "lote", {
          quantidade: count,
          agentes: [...new Set(existentes.map((l) => l.agentId))],
        });
      }

      revalidatePath("/lacunas");
      return {
        ok:
          count === 0
            ? "Elas já tinham sido apagadas."
            : count === 1
              ? "Lacuna apagada."
              : `${count} lacunas apagadas.`,
      };
    },
    (falha) => ({ erro: falha.erro }),
  );
}
