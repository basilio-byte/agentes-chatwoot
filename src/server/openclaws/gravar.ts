import { db } from "@/lib/db";
import { lerConteineres, mesclarConteineres } from "./config";
import { resumoDoLote, type Lote } from "./ingestao";

/**
 * Grava um lote validado, substituindo a janela (ver `ingestao.ts`).
 *
 * Tudo numa transação: o lote entra inteiro ou não entra. Sem ela, uma queda
 * entre o `deleteMany` e o `createMany` deixaria a janela vazia, e a tela
 * mostraria uma semana sem consumo — a leitura mais enganosa possível.
 */
export async function gravarLote(lote: Lote, agora: Date = new Date()) {
  const config = await db.openClawConfig.findUnique({
    where: { id: "unico" },
    select: { conteineres: true },
  });
  const conteineres = mesclarConteineres(lerConteineres(config?.conteineres), lote.conteineres);

  const janela = { gte: lote.desde, lt: lote.ate };
  const dosContainers = { in: lote.conteineres };

  await db.$transaction([
    db.openClawUso.deleteMany({ where: { hora: janela, conteiner: dosContainers } }),
    db.openClawUso.createMany({
      data: lote.uso.map((l) => ({
        hora: l.hora,
        conteiner: l.conteiner,
        agente: l.agente,
        tipo: l.tipo,
        modelo: l.modelo,
        chamadas: l.chamadas,
        entrada: BigInt(l.entrada),
        saida: BigInt(l.saida),
        cacheLeitura: BigInt(l.cacheLeitura),
        cacheEscrita: BigInt(l.cacheEscrita),
      })),
    }),
    db.openClawLimite.deleteMany({ where: { hora: janela, conteiner: dosContainers } }),
    db.openClawLimite.createMany({ data: lote.limites }),
    // `upsert`: a linha única existe desde que o token foi gerado, mas a coleta
    // não deve depender disso para guardar o que leu.
    db.openClawConfig.upsert({
      where: { id: "unico" },
      update: {
        conteineres,
        ultimaColetaEm: agora,
        ultimaColeta: resumoDoLote(lote),
      },
      create: {
        id: "unico",
        conteineres,
        ultimaColetaEm: agora,
        ultimaColeta: resumoDoLote(lote),
      },
    }),
  ]);

  return { uso: lote.uso.length, limites: lote.limites.length };
}
