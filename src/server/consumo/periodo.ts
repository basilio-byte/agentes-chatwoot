import {
  diaEmSaoPaulo,
  inicioDoDiaEmSaoPaulo,
  primeiroDiaDoMes,
  somarDias,
} from "@/lib/tempo";

/**
 * Períodos de apuração.
 *
 * Todo corte é pelo **dia civil de São Paulo**, não por UTC: o container roda
 * em UTC, e um "hoje" calculado por lá começaria às 21h de ontem. Numa tela de
 * apuração financeira isso não é detalhe — é o fechamento do dia errado.
 */
export const PERIODOS = [
  "hoje",
  "ontem",
  "7d",
  "30d",
  "mes",
  "mes-passado",
  "tudo",
  "custom",
] as const;

export type Periodo = (typeof PERIODOS)[number];

export const ROTULO_DO_PERIODO: Record<Periodo, string> = {
  hoje: "Hoje",
  ontem: "Ontem",
  "7d": "7 dias",
  "30d": "30 dias",
  mes: "Este mês",
  "mes-passado": "Mês passado",
  tudo: "Tudo",
  custom: "Personalizado",
};

export const PERIODO_PADRAO: Periodo = "30d";

export function normalizarPeriodo(valor: string | undefined | null): Periodo {
  return (PERIODOS as readonly string[]).includes(valor ?? "")
    ? (valor as Periodo)
    : PERIODO_PADRAO;
}

/** `2026-08-11`, do jeito que o `<input type="date">` manda e devolve. */
const DIA = /^\d{4}-\d{2}-\d{2}$/;

export function ehDiaValido(valor: string | undefined | null): valor is string {
  if (!valor || !DIA.test(valor)) return false;
  // Recusa 2026-02-31: o construtor normaliza para 03/03 em silêncio, e o
  // relatório sairia de um intervalo que ninguém pediu.
  return diaEmSaoPaulo(inicioDoDiaEmSaoPaulo(valor)) === valor;
}

export type Intervalo = {
  /** Instante inclusivo. Nulo = desde sempre. */
  inicio: Date | null;
  /** Instante EXCLUSIVO — é o começo do dia seguinte ao último dia do período. */
  fim: Date | null;
  /** Primeiro dia civil do período, para o eixo do gráfico. */
  primeiroDia: string | null;
  /** Último dia civil do período, inclusive. */
  ultimoDia: string | null;
  rotulo: string;
};

/**
 * Converte o período escolhido em um intervalo de instantes.
 *
 * O fim é **exclusivo** de propósito: comparar com `<=` no último milissegundo
 * do dia deixa de fora as execuções gravadas dentro daquele último segundo com
 * microssegundos — o Postgres guarda mais precisão que o Date do JS. Com
 * `< início do dia seguinte` não há borda para errar.
 */
export function intervaloDoPeriodo(
  periodo: Periodo,
  personalizado: { de?: string | null; ate?: string | null } = {},
  agora = new Date(),
): Intervalo {
  const hoje = diaEmSaoPaulo(agora);

  const montar = (primeiroDia: string, ultimoDia: string, rotulo: string) => ({
    inicio: inicioDoDiaEmSaoPaulo(primeiroDia),
    fim: inicioDoDiaEmSaoPaulo(somarDias(ultimoDia, 1)),
    primeiroDia,
    ultimoDia,
    rotulo,
  });

  switch (periodo) {
    case "hoje":
      return montar(hoje, hoje, "hoje");

    case "ontem": {
      const ontem = somarDias(hoje, -1);
      return montar(ontem, ontem, "ontem");
    }

    // "7 dias" inclui hoje: são os últimos sete dias corridos, e não sete dias
    // que terminam ontem. É o que a pessoa espera ao abrir a tela de manhã.
    case "7d":
      return montar(somarDias(hoje, -6), hoje, "últimos 7 dias");

    case "30d":
      return montar(somarDias(hoje, -29), hoje, "últimos 30 dias");

    case "mes":
      return montar(primeiroDiaDoMes(hoje), hoje, "este mês");

    case "mes-passado": {
      const ultimoDia = somarDias(primeiroDiaDoMes(hoje), -1);
      return montar(primeiroDiaDoMes(ultimoDia), ultimoDia, "mês passado");
    }

    case "custom": {
      const de = ehDiaValido(personalizado.de) ? personalizado.de : null;
      const ate = ehDiaValido(personalizado.ate) ? personalizado.ate : null;

      // Data pela metade cai no padrão em vez de virar um intervalo aberto sem
      // aviso: relatório com uma ponta faltando é pior do que relatório de
      // outro período, porque parece certo.
      if (!de || !ate) return intervaloDoPeriodo(PERIODO_PADRAO, {}, agora);

      // Invertidas, troca em vez de devolver vazio — foi erro de digitação.
      const [inicio, fim] = de <= ate ? [de, ate] : [ate, de];
      return montar(inicio, fim, `${inicio} a ${fim}`);
    }

    case "tudo":
    default:
      return {
        inicio: null,
        fim: null,
        primeiroDia: null,
        ultimoDia: hoje,
        rotulo: "todo o histórico",
      };
  }
}

/** Todos os dias civis do intervalo, para o gráfico não pular dia sem gasto. */
export function diasDoIntervalo(
  intervalo: Intervalo,
  /** Usado quando o período é "tudo": o primeiro dia vem dos próprios dados. */
  primeiroDiaComDados?: string | null,
): string[] {
  const inicio = intervalo.primeiroDia ?? primeiroDiaComDados ?? null;
  const fim = intervalo.ultimoDia;
  if (!inicio || !fim || inicio > fim) return [];

  // Teto de dois anos: acima disso o gráfico diário deixa de ser legível e a
  // lista viraria milhares de colunas de um pixel.
  const dias: string[] = [];
  for (let dia = inicio; dia <= fim && dias.length < 732; dia = somarDias(dia, 1)) {
    dias.push(dia);
  }
  return dias;
}
