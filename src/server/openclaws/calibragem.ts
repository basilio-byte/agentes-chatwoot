import type { Bloqueio } from "./bloqueios";
import { inicioDoCiclo, type Reset } from "./ciclo";

/**
 * Quanto vale a cota semanal, em US$ equivalentes.
 *
 * A Anthropic não publica a cota nem deixa o token dos OpenClaws consultá-la
 * (`HTTP 403: OAuth token does not meet scope requirement user:profile`). O que
 * existe é um fato observável: **o instante em que ela acabou**. Em cada
 * bloqueio, o que a conta tinha gastado desde o último reset é, por definição,
 * 100% da semana. Medido em 26/10/2026: US$ 888, 1.057 e 1.221 equivalentes nas
 * três semanas completas.
 *
 * ⚠ É ESTIMATIVA, e a tela diz. O peso real que a cota dá a cada tipo de token
 * é da Anthropic, e a conta pode ter consumo que o coletor não vê (o Open
 * Design roda Claude Code na mesma assinatura). Cada novo bloqueio é uma
 * amostra a mais, e a estimativa se ajusta sozinha.
 */
export type AmostraDeCota = {
  cicloInicio: Date;
  bloqueioInicio: Date;
  /** Custo equivalente gasto do reset até o bloqueio (a hora dele inclusive). */
  usd: number;
};

export type EstimativaDeCota = {
  usd: number;
  minimo: number;
  maximo: number;
  /** As que entraram na média. */
  amostras: AmostraDeCota[];
  /** As que ficaram de fora por parecerem ciclo incompleto. */
  descartadas: AmostraDeCota[];
};

const HORA_MS = 3_600_000;

/**
 * Uma amostra por bloqueio: o gasto desde o reset do ciclo em que ele começou
 * até o fim da hora da primeira recusa. A hora da recusa entra porque nela
 * ainda houve chamadas boas antes de a conta travar.
 */
export function amostrasDeCota(
  bloqueios: readonly Bloqueio[],
  usdPorHora: readonly { hora: Date; usd: number }[],
  reset: Reset,
): AmostraDeCota[] {
  const vistas = new Set<number>();
  const amostras: AmostraDeCota[] = [];

  // Do mais antigo para o mais novo, só o primeiro bloqueio de cada ciclo:
  // um segundo bloqueio no mesmo ciclo repetiria o mesmo gasto acumulado.
  const emOrdem = [...bloqueios].sort(
    (a, b) => a.inicio.getTime() - b.inicio.getTime(),
  );
  for (const bloqueio of emOrdem) {
    const ciclo = inicioDoCiclo(bloqueio.inicio, reset);
    if (vistas.has(ciclo.getTime())) continue;
    vistas.add(ciclo.getTime());

    const ate = bloqueio.inicio.getTime() + HORA_MS;
    const usd = usdPorHora
      .filter((h) => h.hora.getTime() >= ciclo.getTime() && h.hora.getTime() < ate)
      .reduce((s, h) => s + h.usd, 0);

    amostras.push({ cicloInicio: ciclo, bloqueioInicio: bloqueio.inicio, usd });
  }
  return amostras;
}

/** Abaixo desta fração da mediana, a amostra é tratada como ciclo incompleto. */
const FRACAO_MINIMA_DA_MEDIANA = 0.5;

function mediana(valores: number[]): number {
  const ordenados = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenados.length / 2);
  return ordenados.length % 2
    ? ordenados[meio]
    : (ordenados[meio - 1] + ordenados[meio]) / 2;
}

/**
 * Média das amostras, depois de tirar as que são menos da metade da mediana.
 *
 * Ciclo em que o coletor ainda não cobria todos os OpenClaws, ou em que a conta
 * estourou por um consumo que não vemos, dá uma amostra baixa que puxaria a
 * estimativa para baixo — e uma cota subestimada faz a tela gritar "90%" com
 * folga de sobra. Sem nenhuma amostra, `null`: a tela diz que ainda não mediu.
 */
export function estimarCota(
  amostras: readonly AmostraDeCota[],
): EstimativaDeCota | null {
  const utilizaveis = amostras.filter((a) => a.usd > 0);
  if (utilizaveis.length === 0) return null;

  const corte = mediana(utilizaveis.map((a) => a.usd)) * FRACAO_MINIMA_DA_MEDIANA;
  const validas = utilizaveis.filter((a) => a.usd >= corte);
  const descartadas = amostras.filter((a) => !validas.includes(a));

  const valores = validas.map((a) => a.usd);
  return {
    usd: valores.reduce((s, v) => s + v, 0) / valores.length,
    minimo: Math.min(...valores),
    maximo: Math.max(...valores),
    amostras: validas,
    descartadas,
  };
}
