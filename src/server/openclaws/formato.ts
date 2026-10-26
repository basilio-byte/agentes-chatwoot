/**
 * `0.214` → `21%`; `0.0466` → `4,7%`; `0.0002` → `<0,1%`. Sem base, `—` em vez de
 * um zero que pareceria folga; e quem gastou pouco NÃO aparece como `0,0%`, que
 * se leria como "não gastou".
 */
export function percentual(fracao: number | null | undefined): string {
  if (fracao == null || !Number.isFinite(fracao)) return "—";
  const pct = fracao * 100;
  if (pct > 0 && pct < 0.1) return "<0,1%";
  // Abaixo de 10% uma casa decimal faz diferença (4,7% ≠ 5%); acima, é ruído.
  const casas = pct > 0 && pct < 10 ? 1 : 0;
  return `${new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  }).format(pct)}%`;
}

/** `20` → `20 h`; `75` → `75 h (3,1 dias)`. Bloqueio de dias lê melhor em dias. */
export function duracaoEmHoras(horas: number): string {
  const h = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(horas);
  if (horas < 48) return `${h} h`;
  const dias = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(horas / 24);
  return `${h} h (${dias} dias)`;
}

/** Há quanto tempo foi `quando`, em linguagem de gente: `há 3 h`, `há 2 dias`. */
export function haQuanto(quando: Date, agora: Date): string {
  const min = Math.max(0, Math.round((agora.getTime() - quando.getTime()) / 60_000));
  if (min < 2) return "agora há pouco";
  if (min < 90) return `há ${min} min`;
  const horas = Math.round(min / 60);
  if (horas < 48) return `há ${horas} h`;
  return `há ${Math.round(horas / 24)} dias`;
}

/**
 * US$ com duas casas, que é o que um custo EQUIVALENTE comporta: quatro casas
 * fingem uma precisão que a tarifa de API aplicada a uma assinatura não tem.
 * O que é menos de um centavo diz isso, em vez de virar `US$ 0,00`.
 */
export function usd(valor: number): string {
  if (valor > 0 && valor < 0.01) return "< US$ 0,01";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(valor);
}
