import { parseExpression } from "cron-parser";
import { FUSO_SEAHUB } from "@/lib/tempo";

/**
 * Leitura e validação de expressão cron.
 *
 * Puro e testado porque é onde um agendamento erra em silêncio: expressão certa
 * no fuso errado dispara três horas fora todo dia, sem erro nenhum, e ninguém
 * percebe até o resultado chegar na hora errada por uma semana.
 *
 * ⚠ **Sempre em `America/Sao_Paulo`.** O container roda em UTC: `0 9 * * *` sem
 * fuso dispara às 6h da manhã em São Paulo. É a mesma armadilha que o AGENTS.md
 * já registra para datas exibidas, e aqui ela é pior — data exibida errada
 * alguém nota, execução na hora errada não.
 */

/**
 * Intervalo mínimo entre duas execuções.
 *
 * `* * * * *` são 1440 turnos por dia, cada um pagando modelo e tools. Cinco
 * minutos ainda é agressivo para um agente, mas é um piso que impede o erro de
 * digitação de virar fatura. Quem precisa de mais frequência que isso não
 * queria um agente — queria um script.
 */
export const INTERVALO_MINIMO_MINUTOS = 5;

/** Quantas ocorrências a tela mostra para conferência. */
export const OCORRENCIAS_PARA_CONFERIR = 3;

export type LeituraDoCron =
  | { valida: true; proximas: Date[] }
  | { valida: false; erro: string };

/**
 * Valida a expressão e devolve as próximas execuções.
 *
 * As datas voltam como `Date` normal — quem exibe formata no fuso da Seahub,
 * como todo o resto do painel. O que o fuso muda aqui é o **cálculo**: "todo dia
 * às 9h" resolve para 12h UTC.
 */
export function lerCron(
  expressao: string,
  quantidade = OCORRENCIAS_PARA_CONFERIR,
  referencia = new Date(),
): LeituraDoCron {
  const limpa = expressao.trim();
  if (!limpa) return { valida: false, erro: "Informe a expressão." };

  // Cinco campos. O cron-parser aceita seis (com segundos), e isso seria uma
  // porta lateral para agendar de segundo em segundo, furando o piso abaixo.
  const campos = limpa.split(/\s+/);
  if (campos.length !== 5) {
    return {
      valida: false,
      erro: `A expressão precisa ter 5 campos (minuto hora dia mês dia-da-semana); esta tem ${campos.length}.`,
    };
  }

  try {
    const iterador = parseExpression(limpa, {
      currentDate: referencia,
      tz: FUSO_SEAHUB,
    });

    const proximas: Date[] = [];
    for (let i = 0; i < quantidade; i++) {
      proximas.push(iterador.next().toDate());
    }

    return { valida: true, proximas };
  } catch (erro) {
    return {
      valida: false,
      erro:
        erro instanceof Error
          ? `Expressão inválida: ${erro.message}`
          : "Expressão inválida.",
    };
  }
}

export type VereditoDaFrequencia =
  | { pode: true; proximas: Date[] }
  | { pode: false; erro: string };

/**
 * Valida a expressão **e** o intervalo entre as ocorrências.
 *
 * Olha o MENOR intervalo entre execuções consecutivas, não a média: uma
 * expressão que dispara de minuto em minuto durante uma hora e depois dorme o
 * dia todo tem média mansa e é exatamente o que este piso existe para pegar.
 */
export function validarFrequencia(
  expressao: string,
  referencia = new Date(),
): VereditoDaFrequencia {
  // Quatro ocorrências para conseguir medir três intervalos.
  const leitura = lerCron(expressao, 4, referencia);
  if (!leitura.valida) return { pode: false, erro: leitura.erro };

  const { proximas } = leitura;
  let menorMs = Infinity;
  for (let i = 1; i < proximas.length; i++) {
    menorMs = Math.min(menorMs, proximas[i].getTime() - proximas[i - 1].getTime());
  }

  const minimoMs = INTERVALO_MINIMO_MINUTOS * 60_000;
  if (menorMs < minimoMs) {
    return {
      pode: false,
      erro: `Frequência alta demais: as execuções ficariam a cada ${Math.round(
        menorMs / 60_000,
      )} minuto(s). O mínimo é ${INTERVALO_MINIMO_MINUTOS} — cada execução roda o modelo e é cobrada.`,
    };
  }

  return { pode: true, proximas: proximas.slice(0, OCORRENCIAS_PARA_CONFERIR) };
}

/**
 * Há quantos minutos passou a ocorrência mais recente desta expressão.
 *
 * É assim que se mede o atraso, e não pelo relógio do job: quando o worker
 * está fora do ar na hora marcada, o BullMQ entrega a ocorrência quando ele
 * volta, e nada no job diz que ele chegou tarde. Perguntar ao cron "qual era a
 * hora certa?" é a única fonte confiável.
 *
 * `null` quando a expressão não é legível — quem chama trata como "não sei" e
 * executa, porque perder execução por dúvida é pior que executar atrasado.
 */
export function ocorrenciaAnterior(
  expressao: string,
  agora = new Date(),
): Date | null {
  try {
    // ⚠ O segundo de folga não é detalhe. `prev()` devolve a ocorrência
    // ESTRITAMENTE anterior à data de referência: disparando exatamente no
    // segundo marcado, ele pularia para a ocorrência de ontem e o atraso
    // calculado seria de 24 horas — o agendamento diário seria descartado
    // todo santo dia, por chegar pontual demais.
    const iterador = parseExpression(expressao.trim(), {
      currentDate: new Date(agora.getTime() + 1_000),
      tz: FUSO_SEAHUB,
    });
    return iterador.prev().toDate();
  } catch {
    return null;
  }
}

/** Há quantos minutos passou a hora certa. `null` se a expressão não é legível. */
export function atrasoEmMinutos(
  expressao: string,
  agora = new Date(),
): number | null {
  const anterior = ocorrenciaAnterior(expressao, agora);
  if (!anterior) return null;
  return Math.max(0, Math.round((agora.getTime() - anterior.getTime()) / 60_000));
}

export type VereditoDoAtraso =
  | { executa: true }
  | { executa: false; atrasoMinutos: number; toleranciaMinutos: number };

/**
 * Vale executar uma ocorrência que chegou atrasada?
 *
 * Rodar "o resumo das 8h" às 15h, como se nada fosse, é pior que não rodar: o
 * agente age sobre um contexto que já passou — abre a tarefa "de hoje" na hora
 * errada, cobra quem já pagou. Mas um deploy de dois minutos em cima do horário
 * não pode custar a execução do dia, e é por isso que existe tolerância em vez
 * de exigir pontualidade.
 *
 * Atraso desconhecido executa: a dúvida aqui pende para fazer, ao contrário da
 * regra de atendimento, porque não há cliente para atropelar.
 */
export function decidirPeloAtraso(
  atrasoMinutos: number | null,
  toleranciaMinutos: number,
): VereditoDoAtraso {
  if (atrasoMinutos == null) return { executa: true };
  if (atrasoMinutos <= toleranciaMinutos) return { executa: true };
  return { executa: false, atrasoMinutos, toleranciaMinutos };
}

/**
 * Atalhos que a tela oferece, para ninguém precisar saber escrever cron.
 *
 * O campo livre continua existindo ao lado: fechar só nos atalhos tiraria casos
 * legítimos ("primeira segunda do mês", "dias úteis às 7h").
 */
export type Atalho = "diario" | "dias_uteis" | "semanal" | "mensal" | "horas";

export function expressaoDoAtalho(args: {
  atalho: Atalho;
  hora: number;
  minuto: number;
  /** 0=domingo … 6=sábado. Só para `semanal`. */
  diaDaSemana?: number;
  /** 1–28. Só para `mensal`. */
  diaDoMes?: number;
  /** Só para `horas`. */
  aCadaHoras?: number;
}): string {
  const m = Math.min(59, Math.max(0, Math.trunc(args.minuto)));
  const h = Math.min(23, Math.max(0, Math.trunc(args.hora)));

  switch (args.atalho) {
    case "diario":
      return `${m} ${h} * * *`;
    case "dias_uteis":
      return `${m} ${h} * * 1-5`;
    case "semanal":
      return `${m} ${h} * * ${Math.min(6, Math.max(0, args.diaDaSemana ?? 1))}`;
    case "mensal":
      // Teto em 28 de propósito: dia 30 nunca roda em fevereiro, e um
      // agendamento que some em certos meses é pior que um dia antes.
      return `${m} ${h} ${Math.min(28, Math.max(1, args.diaDoMes ?? 1))} * *`;
    case "horas": {
      const n = Math.min(23, Math.max(1, Math.trunc(args.aCadaHoras ?? 1)));
      return `${m} */${n} * * *`;
    }
  }
}
