/**
 * O ciclo semanal da conta Claude dos OpenClaws.
 *
 * A cota recomeça uma vez por semana, num instante fixo. Medido em 26/10/2026,
 * nos quatro bloqueios do mês: o último 429 caiu entre 18:31 e 18:57 UTC de
 * domingo e a primeira chamada boa, às 19:00–19:11 — todas as semanas. Então o
 * padrão é **domingo, 19:00 UTC (16:00 em São Paulo)**, editável na tela porque
 * trocar o login da conta muda esse horário.
 *
 * ⚠ Este NÃO é o ciclo do proxy Claude MAX da Seahub, que recomeça no domingo
 * às 10:59 UTC: é outra conta. Misturar os dois mostraria a cota de quem não
 * está sendo medido.
 *
 * Tudo aqui é em UTC, de propósito: o relógio da conta é da Anthropic, não
 * nosso, e o fuso de São Paulo só entra na hora de exibir.
 */
export type Reset = {
  /** 0 = domingo … 6 = sábado. */
  diaSemana: number;
  /** 0–23, em UTC. */
  horaUtc: number;
};

export const RESET_PADRAO: Reset = { diaSemana: 0, horaUtc: 19 };

const HORA_MS = 3_600_000;
const SEMANA_MS = 7 * 24 * HORA_MS;

/** O instante de reset mais recente que não passa de `referencia`. */
export function inicioDoCiclo(referencia: Date, reset: Reset): Date {
  const dia = Date.UTC(
    referencia.getUTCFullYear(),
    referencia.getUTCMonth(),
    referencia.getUTCDate(),
    reset.horaUtc,
  );
  const diasDesdeODiaDoReset = (referencia.getUTCDay() - reset.diaSemana + 7) % 7;
  let inicio = dia - diasDesdeODiaDoReset * 24 * HORA_MS;
  // Mesmo dia da semana, mas ainda antes da hora do reset: o ciclo em curso é o
  // da semana passada.
  if (inicio > referencia.getTime()) inicio -= SEMANA_MS;
  return new Date(inicio);
}

export function fimDoCiclo(inicio: Date): Date {
  return new Date(inicio.getTime() + SEMANA_MS);
}

export type Ciclo = { inicio: Date; fim: Date };

/** Os `quantos` ciclos mais recentes, o atual primeiro. */
export function ciclosRecentes(
  referencia: Date,
  reset: Reset,
  quantos: number,
): Ciclo[] {
  const atual = inicioDoCiclo(referencia, reset).getTime();
  return Array.from({ length: quantos }, (_, i) => {
    const inicio = new Date(atual - i * SEMANA_MS);
    return { inicio, fim: fimDoCiclo(inicio) };
  });
}

/** `valor` está em [inicio, fim)? O fim é exclusivo, como nas outras apurações. */
export function estaNoCiclo(valor: Date, ciclo: Ciclo): boolean {
  return (
    valor.getTime() >= ciclo.inicio.getTime() &&
    valor.getTime() < ciclo.fim.getTime()
  );
}
