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
