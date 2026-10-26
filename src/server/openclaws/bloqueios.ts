import type { LinhaDeLimite } from "./agregacao";

/**
 * Quando a conta travou por cota.
 *
 * O OpenClaw não avisa ninguém: a Anthropic devolve 429 ("exceed your account's
 * rate limit"), o agente tenta de novo a cada heartbeat e a conversa fica
 * muda. O rastro são as chamadas recusadas, e é por elas que a tela conta os
 * bloqueios — medidos em 26/10/2026, quatro em quatro semanas, de 20 a 75 horas.
 *
 * ⚠ Um 429 solto NÃO é bloqueio. Pico de requisições por minuto também devolve
 * 429 e passa sozinho; no mês havia dezenas de recusas espalhadas que não
 * pararam ninguém. Bloqueio por cota é recusa CONTÍNUA: pelo menos
 * `MIN_DE_RECUSAS` ao longo de pelo menos `MIN_DE_HORAS` horas, sem buraco de
 * mais de `LACUNA_MAXIMA_EM_HORAS` entre elas (o agente repete a tentativa de
 * hora em hora, então uma hora sem recusa no meio é só uma falha de coleta).
 */
export const MIN_DE_RECUSAS = 10;
export const MIN_DE_HORAS = 3;
export const LACUNA_MAXIMA_EM_HORAS = 3;

const HORA_MS = 3_600_000;

export type Bloqueio = {
  /** Início da hora da primeira recusa. */
  inicio: Date;
  /** Fim da hora da última recusa: é quando a conta voltou, com folga de uma hora. */
  fim: Date;
  horas: number;
  recusas: number;
  /** Os OpenClaws que levaram a recusa, em ordem alfabética. */
  conteineres: string[];
  /** A última recusa é recente: a conta pode estar travada agora. */
  emCurso: boolean;
};

/** Acima disto sem recusa nova, o bloqueio é dado como terminado. */
const FOLGA_DO_EM_CURSO_EM_HORAS = 2;

export function detectarBloqueios(
  limites: readonly LinhaDeLimite[],
  agora: Date,
  /** Só estes entram. Vazio ou ausente = todos. */
  daConta?: ReadonlySet<string>,
): Bloqueio[] {
  const porHora = new Map<number, { recusas: number; conteineres: Set<string> }>();
  for (const l of limites) {
    if (l.categoria !== "rate_limit" || l.quantidade <= 0) continue;
    if (daConta && daConta.size > 0 && !daConta.has(l.conteiner)) continue;
    const k = l.hora.getTime();
    const hora = porHora.get(k) ?? { recusas: 0, conteineres: new Set<string>() };
    hora.recusas += l.quantidade;
    hora.conteineres.add(l.conteiner);
    porHora.set(k, hora);
  }

  const horas = [...porHora.keys()].sort((a, b) => a - b);
  const grupos: number[][] = [];
  for (const h of horas) {
    const atual = grupos[grupos.length - 1];
    if (atual && h - atual[atual.length - 1] <= LACUNA_MAXIMA_EM_HORAS * HORA_MS) {
      atual.push(h);
    } else {
      grupos.push([h]);
    }
  }

  const bloqueios: Bloqueio[] = [];
  for (const grupo of grupos) {
    const primeira = grupo[0];
    const ultima = grupo[grupo.length - 1];
    const duracao = (ultima - primeira) / HORA_MS + 1;
    const recusas = grupo.reduce((s, h) => s + porHora.get(h)!.recusas, 0);
    if (duracao < MIN_DE_HORAS || recusas < MIN_DE_RECUSAS) continue;

    const conteineres = new Set<string>();
    for (const h of grupo) for (const c of porHora.get(h)!.conteineres) conteineres.add(c);

    const fim = ultima + HORA_MS;
    bloqueios.push({
      inicio: new Date(primeira),
      fim: new Date(fim),
      horas: duracao,
      recusas,
      conteineres: [...conteineres].sort(),
      emCurso: agora.getTime() - fim < FOLGA_DO_EM_CURSO_EM_HORAS * HORA_MS,
    });
  }

  // O mais recente primeiro: é o que a tela mostra no topo.
  return bloqueios.sort((a, b) => b.inicio.getTime() - a.inicio.getTime());
}

/** Quantas horas de [de, ate) caíram dentro de algum bloqueio. */
export function horasBloqueadasEntre(
  bloqueios: readonly Bloqueio[],
  de: Date,
  ate: Date,
): number {
  let ms = 0;
  for (const b of bloqueios) {
    const ini = Math.max(b.inicio.getTime(), de.getTime());
    const fim = Math.min(b.fim.getTime(), ate.getTime());
    if (fim > ini) ms += fim - ini;
  }
  return ms / HORA_MS;
}
