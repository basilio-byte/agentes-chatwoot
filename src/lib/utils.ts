import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { FUSO_SEAHUB } from "@/lib/tempo";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Toda data exibida no painel, em horário de São Paulo.
 *
 * O fuso é fixo pelo mesmo motivo que em `agoraEmSaoPaulo`: estas telas são
 * componentes de servidor, e o container roda em UTC no Easypanel — sem fixar,
 * "última alteração" aparecia três horas adiantada.
 *
 * Fixar também mantém servidor e navegador exibindo o mesmo texto, o que evita
 * divergência de hidratação em componente que renderiza dos dois lados.
 */
export function formatarData(data: Date | string) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO_SEAHUB,
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(data));
}

export function formatarUsd(valor: number | null | undefined) {
  if (valor == null) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: valor < 0.01 ? 4 : 2,
    maximumFractionDigits: 4,
  }).format(valor);
}

/**
 * Dinheiro curto, para eixo de gráfico e coluna estreita: `$0,12`, `$3,40`.
 *
 * Separado de `formatarUsd` porque ali o prefixo `US$` e as quatro casas são
 * desejáveis — num tick de eixo repetido cinco vezes, viram ruído.
 */
export function formatarUsdCurto(valor: number) {
  const casas = valor > 0 && valor < 0.1 ? 3 : 2;
  const numero = new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  }).format(valor);
  return `$${numero}`;
}

export function formatarNumero(valor: number) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(
    valor,
  );
}

/** `135334` → `2 min 15 s`. Latência de turno passa de minuto com frequência. */
export function formatarDuracao(ms: number | null | undefined) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const segundos = ms / 1000;
  if (segundos < 60) {
    // Vírgula, não ponto: o resto do painel é pt-BR e "5.4 s" destoa.
    const casas = segundos < 10 ? 1 : 0;
    return `${new Intl.NumberFormat("pt-BR", {
      minimumFractionDigits: casas,
      maximumFractionDigits: casas,
    }).format(segundos)} s`;
  }
  const minutos = Math.floor(segundos / 60);
  return `${minutos} min ${Math.round(segundos - minutos * 60)} s`;
}
