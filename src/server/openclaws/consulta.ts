import { db } from "@/lib/db";
import type { LinhaDeLimite, LinhaDeUso } from "./agregacao";
import { RESET_PADRAO, type Reset } from "./ciclo";
import {
  lerConteineres,
  resetValido,
  type ConteinerConfigurado,
} from "./config";

/**
 * Acima disto a tela recusa mostrar: somar só parte do histórico faria a cota
 * de um ciclo parecer folgada. São ~75 linhas por dia hoje, então 60 mil
 * cobrem mais de dois anos.
 */
export const TETO_DE_LINHAS = 60_000;

export type ConfigLida = {
  /** Há token do coletor gerado? O token em si nunca sai do banco. */
  temToken: boolean;
  tokenDica: string | null;
  conteineres: ConteinerConfigurado[];
  cotaManualUsd: number | null;
  reset: Reset;
  ultimaColetaEm: Date | null;
  ultimaColeta: string | null;
};

export async function lerConfig(): Promise<ConfigLida> {
  const c = await db.openClawConfig.findUnique({ where: { id: "unico" } });
  return {
    temToken: Boolean(c?.tokenHash),
    tokenDica: c?.tokenDica ?? null,
    conteineres: lerConteineres(c?.conteineres),
    cotaManualUsd:
      c?.cotaSemanalUsd != null && c.cotaSemanalUsd > 0 ? c.cotaSemanalUsd : null,
    reset: c ? resetValido(c.resetDiaSemana, c.resetHoraUtc) : RESET_PADRAO,
    ultimaColetaEm: c?.ultimaColetaEm ?? null,
    ultimaColeta: c?.ultimaColeta ?? null,
  };
}

export type HistoricoLido = {
  linhas: LinhaDeUso[];
  limites: LinhaDeLimite[];
  /** Passou do teto: o que veio é parte do histórico, e a tela não deve somar. */
  cortado: boolean;
};

export async function lerHistorico(): Promise<HistoricoLido> {
  const [uso, limites] = await Promise.all([
    db.openClawUso.findMany({
      orderBy: { hora: "desc" },
      take: TETO_DE_LINHAS + 1,
    }),
    db.openClawLimite.findMany({ orderBy: { hora: "desc" }, take: TETO_DE_LINHAS }),
  ]);

  return {
    cortado: uso.length > TETO_DE_LINHAS,
    linhas: uso.slice(0, TETO_DE_LINHAS).map((l) => ({
      hora: l.hora,
      conteiner: l.conteiner,
      agente: l.agente,
      tipo: l.tipo,
      modelo: l.modelo,
      chamadas: l.chamadas,
      // BigInt → number: o maior total possível (bilhões de tokens) cabe com
      // folga nos 2^53 de um número do JS.
      entrada: Number(l.entrada),
      saida: Number(l.saida),
      cacheLeitura: Number(l.cacheLeitura),
      cacheEscrita: Number(l.cacheEscrita),
    })),
    limites: limites.map((l) => ({
      hora: l.hora,
      conteiner: l.conteiner,
      categoria: l.categoria,
      quantidade: l.quantidade,
    })),
  };
}
