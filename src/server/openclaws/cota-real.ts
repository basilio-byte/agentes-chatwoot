import { inicioDoCiclo, type Ciclo, type Reset } from "./ciclo";

/**
 * A cota REAL da conta, como a Anthropic a informa.
 *
 * Só existe depois do login completo da conta no servidor dos OpenClaws: o token
 * de inferência deles recebe `HTTP 403 … user:profile` ao tentar ler a
 * utilização. Com a leitura, a tela deixa de ESTIMAR a % pelos bloqueios e passa
 * a mostrar a que a Anthropic mede — e a estimativa vira rede de segurança e
 * conferência.
 *
 * ⚠ **O número é da conta INTEIRA**, não só dos OpenClaws: Claude Code em qualquer
 * máquina, claude.ai e o Open Design saem da mesma cota. A divisão entre pessoas é
 * proporcional ao consumo dos OpenClaws, e a tela diz isso.
 */
export type LeituraDeCota = {
  lidaEm: Date;
  /** five_hour · seven_day · seven_day_opus · seven_day_sonnet · … */
  janela: string;
  /** 0 a 100 (pode passar disso com uso extra liberado). */
  utilizacao: number;
  resetaEm: Date | null;
  plano: string | null;
};

export type JanelaMedida = {
  janela: string;
  utilizacao: number;
  resetaEm: Date | null;
};

export type CotaReal = {
  lidaEm: Date;
  plano: string | null;
  janelas: JanelaMedida[];
  /** A janela da SEMANA, que é a cota que bloqueia por dias. */
  semanal: JanelaMedida | null;
  /** A janela de 5 horas: bloqueia por poucas horas e mexe mais. */
  cincoHoras: JanelaMedida | null;
  /** A leitura é velha demais para descrever agora: a tela a mostra, mas não manda nela. */
  atrasada: boolean;
};

/** O coletor roda a cada 2 h; passando de 6 sem leitura nova, algo falhou (login vencido, rede). */
export const LEITURA_ATRASADA_EM_HORAS = 6;

const HORA_MS = 3_600_000;

const ROTULOS: Record<string, string> = {
  five_hour: "Janela de 5 horas",
  seven_day: "Semana (todos os modelos)",
  seven_day_opus: "Semana · Opus",
  seven_day_sonnet: "Semana · Sonnet",
  seven_day_oauth_apps: "Semana · apps de terceiros",
};

/** O nome em português de uma janela; a chave crua só quando não há tradução. */
export function rotuloDaJanela(chave: string): string {
  if (ROTULOS[chave]) return ROTULOS[chave];
  if (chave.startsWith("model:")) return `Semana · ${chave.slice(6)}`;
  return chave;
}

/** Janelas na ordem em que a tela as mostra: cota semanal, 5 horas, e o resto. */
const ORDEM = ["seven_day", "five_hour", "seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps"];

function ordenar(janelas: JanelaMedida[]): JanelaMedida[] {
  const posicao = (j: string) => {
    const i = ORDEM.indexOf(j);
    return i === -1 ? ORDEM.length : i;
  };
  return [...janelas].sort((a, b) => posicao(a.janela) - posicao(b.janela) || a.janela.localeCompare(b.janela));
}

/** A leitura mais recente (todas as janelas dela), ou `null` se nunca houve. */
export function cotaRealMaisRecente(
  leituras: readonly LeituraDeCota[],
  agora: Date,
): CotaReal | null {
  if (leituras.length === 0) return null;
  const maisRecente = Math.max(...leituras.map((l) => l.lidaEm.getTime()));
  const daVez = leituras.filter((l) => l.lidaEm.getTime() === maisRecente);

  const janelas = ordenar(
    daVez.map((l) => ({ janela: l.janela, utilizacao: l.utilizacao, resetaEm: l.resetaEm })),
  );
  return {
    lidaEm: new Date(maisRecente),
    plano: daVez.find((l) => l.plano)?.plano ?? null,
    janelas,
    semanal: janelas.find((j) => j.janela === "seven_day") ?? null,
    cincoHoras: janelas.find((j) => j.janela === "five_hour") ?? null,
    atrasada: agora.getTime() - maisRecente > LEITURA_ATRASADA_EM_HORAS * HORA_MS,
  };
}

/** O maior percentual semanal lido dentro de um ciclo (o fim do ciclo é o que conta), ou `null`. */
export function utilizacaoSemanalNoCiclo(
  leituras: readonly LeituraDeCota[],
  ciclo: Ciclo,
): number | null {
  const doCiclo = leituras.filter(
    (l) =>
      l.janela === "seven_day" &&
      l.lidaEm.getTime() >= ciclo.inicio.getTime() &&
      l.lidaEm.getTime() < ciclo.fim.getTime(),
  );
  return doCiclo.length === 0 ? null : Math.max(...doCiclo.map((l) => l.utilizacao));
}

/** Abaixo disto o percentual é arredondamento demais para dividir por ele. */
const UTILIZACAO_MINIMA_PARA_CALIBRAR = 5;
/** Só as leituras mais novas entram: a relação mudar com o tempo (modelo novo, tarifa) é esperado. */
const MAX_DE_LEITURAS_NA_CALIBRAGEM = 24;

export type CalibragemPelasLeituras = {
  /** US$ equivalentes dos OpenClaws que correspondem a 100% da semana. */
  usd: number;
  leituras: number;
};

function mediana(valores: number[]): number {
  const o = [...valores].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
}

/**
 * Quanto vale 100% da semana, em US$ equivalentes dos OpenClaws, **pela leitura
 * real**: o gasto desde o reset até o instante da leitura, dividido pela
 * utilização que a Anthropic mediu. Mediana das leituras mais recentes — a
 * leitura isolada oscila (1% de arredondamento em 8% é 12% de erro).
 *
 * É a mesma pergunta que `calibragem.ts` responde pelos bloqueios, só que a cada
 * leitura e não só no dia em que a conta trava: por isso passa a valer desde a
 * primeira semana, e não depois do próximo bloqueio.
 */
export function calibrarPelasLeituras(
  leituras: readonly LeituraDeCota[],
  usdPorHora: readonly { hora: Date; usd: number }[],
  reset: Reset,
): CalibragemPelasLeituras | null {
  const candidatas = leituras
    .filter((l) => l.janela === "seven_day" && l.utilizacao >= UTILIZACAO_MINIMA_PARA_CALIBRAR)
    .sort((a, b) => b.lidaEm.getTime() - a.lidaEm.getTime())
    .slice(0, MAX_DE_LEITURAS_NA_CALIBRAGEM);

  const razoes: number[] = [];
  for (const l of candidatas) {
    const inicio = inicioDoCiclo(l.lidaEm, reset).getTime();
    // A hora da leitura entra: o coletor manda o uso e a leitura no mesmo instante.
    const ate = Math.floor(l.lidaEm.getTime() / HORA_MS) * HORA_MS + HORA_MS;
    const usd = usdPorHora
      .filter((h) => h.hora.getTime() >= inicio && h.hora.getTime() < ate)
      .reduce((s, h) => s + h.usd, 0);
    if (usd > 0) razoes.push(usd / (l.utilizacao / 100));
  }
  if (razoes.length === 0) return null;
  return { usd: mediana(razoes), leituras: razoes.length };
}
