import { diaEmSaoPaulo } from "@/lib/tempo";
import type { PontoDoDia } from "@/server/consumo/agregacao";
import { custoEquivalente, ehModeloClaude } from "./precos";

/** Uma hora de um agente de um OpenClaw, num modelo e tipo de sessão. */
export type LinhaDeUso = {
  hora: Date;
  conteiner: string;
  agente: string;
  /** main · dashboard · cron · subagent · … */
  tipo: string;
  modelo: string;
  chamadas: number;
  entrada: number;
  saida: number;
  cacheLeitura: number;
  cacheEscrita: number;
};

/** Chamadas recusadas pela Anthropic numa hora. */
export type LinhaDeLimite = {
  hora: Date;
  conteiner: string;
  categoria: string;
  quantidade: number;
};

export type Totais = {
  chamadas: number;
  entrada: number;
  saida: number;
  cacheLeitura: number;
  cacheEscrita: number;
  /** Custo equivalente (tarifa de API) só do que tem tarifa. Régua, não fatura. */
  usd: number;
  /** Chamadas de modelo Claude sem linha na tabela de tarifas: ficam FORA do `usd`. */
  chamadasSemTarifa: number;
  /** Chamadas de modelo que não é da conta Claude (OpenRouter): idem. */
  chamadasForaDaConta: number;
};

export function totaisZerados(): Totais {
  return {
    chamadas: 0,
    entrada: 0,
    saida: 0,
    cacheLeitura: 0,
    cacheEscrita: 0,
    usd: 0,
    chamadasSemTarifa: 0,
    chamadasForaDaConta: 0,
  };
}

/** Tudo que o modelo processou: entrada, saída e as duas direções do cache. */
export function tokensProcessados(t: Totais): number {
  return t.entrada + t.saida + t.cacheLeitura + t.cacheEscrita;
}

function acumular(total: Totais, linha: LinhaDeUso) {
  total.chamadas += linha.chamadas;
  total.entrada += linha.entrada;
  total.saida += linha.saida;
  total.cacheLeitura += linha.cacheLeitura;
  total.cacheEscrita += linha.cacheEscrita;

  if (!ehModeloClaude(linha.modelo)) {
    total.chamadasForaDaConta += linha.chamadas;
    return;
  }
  const custo = custoEquivalente(linha.modelo, linha);
  if (custo === null) total.chamadasSemTarifa += linha.chamadas;
  else total.usd += custo;
}

export function totalizar(linhas: readonly LinhaDeUso[]): Totais {
  const total = totaisZerados();
  for (const linha of linhas) acumular(total, linha);
  return total;
}

/** Agrupa e totaliza. A ordem do resultado é a do primeiro aparecimento. */
export function totalizarPor(
  linhas: readonly LinhaDeUso[],
  chave: (linha: LinhaDeUso) => string,
): Map<string, Totais> {
  const mapa = new Map<string, Totais>();
  for (const linha of linhas) {
    const k = chave(linha);
    let total = mapa.get(k);
    if (!total) {
      total = totaisZerados();
      mapa.set(k, total);
    }
    acumular(total, linha);
  }
  return mapa;
}

/** Custo equivalente por hora, em ordem. Base da calibração da cota. */
export function usdPorHora(
  linhas: readonly LinhaDeUso[],
): { hora: Date; usd: number }[] {
  const mapa = new Map<number, number>();
  for (const linha of linhas) {
    if (!ehModeloClaude(linha.modelo)) continue;
    const custo = custoEquivalente(linha.modelo, linha);
    if (custo === null) continue;
    const k = linha.hora.getTime();
    mapa.set(k, (mapa.get(k) ?? 0) + custo);
  }
  return [...mapa.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, usd]) => ({ hora: new Date(k), usd }));
}

/**
 * Uma coluna por dia civil de São Paulo, sem pular dia: o dia sem uso aparece
 * como zero. No gráfico reaproveitado de `/consumo`, "custoUsd" é o custo
 * equivalente, "execucoes" são as chamadas ao modelo e "tokens" tudo o que foi
 * processado.
 */
export function serieDiaria(
  linhas: readonly LinhaDeUso[],
  dias: readonly string[],
): PontoDoDia[] {
  const pontos = new Map<string, PontoDoDia>(
    dias.map((dia) => [dia, { dia, custoUsd: 0, execucoes: 0, tokens: 0 }]),
  );
  for (const linha of linhas) {
    const ponto = pontos.get(diaEmSaoPaulo(linha.hora));
    if (!ponto) continue;
    const t = totalizar([linha]);
    ponto.custoUsd += t.usd;
    ponto.execucoes += t.chamadas;
    ponto.tokens += tokensProcessados(t);
  }
  return dias.map((dia) => pontos.get(dia)!);
}
