export const FUSO_SEAHUB = "America/Sao_Paulo";

const DIAS = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
];

/**
 * Data e hora de São Paulo em texto, para o agente saber "que dia é hoje".
 *
 * Usa `Intl` com fuso fixo em vez do relógio do servidor: o container roda em
 * UTC no Easypanel, e o agente atende gente que fala "amanhã" pensando no
 * horário de Brasília.
 */
export function agoraEmSaoPaulo(referencia = new Date()) {
  const partes = new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO_SEAHUB,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hour12: false,
  }).formatToParts(referencia);

  const parte = (tipo: Intl.DateTimeFormatPartTypes) =>
    partes.find((p) => p.type === tipo)?.value ?? "";

  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO_SEAHUB,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(referencia);

  // O nome do dia em pt-BR varia de capitalização e sufixo entre runtimes.
  // Derivar do código curto em inglês é estável em qualquer Node.
  const curto = new Intl.DateTimeFormat("en-US", {
    timeZone: FUSO_SEAHUB,
    weekday: "short",
  }).format(referencia);
  const indiceDia = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    curto,
  );

  return {
    /** `2026-07-28` — bom para o modelo calcular datas. */
    iso,
    data: `${parte("day")}/${parte("month")}/${parte("year")}`,
    hora: `${parte("hour")}:${parte("minute")}`,
    diaDaSemana: DIAS[indiceDia] ?? "",
  };
}

/** `2026-08-11` — o dia civil em São Paulo de um instante qualquer. */
export function diaEmSaoPaulo(referencia: Date) {
  return agoraEmSaoPaulo(referencia).iso;
}

/**
 * Quanto São Paulo está adiantado em relação ao UTC naquele instante, em ms
 * (negativo — o Brasil está a oeste).
 *
 * Calculado a partir do `Intl` em vez de fixado em -3h de propósito: o horário
 * de verão foi extinto em 2019, mas nada garante que não volte, e a apuração
 * financeira do dia erraria por uma hora inteira nas bordas se voltasse.
 */
function deslocamentoDeSaoPaulo(instante: Date) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO_SEAHUB,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instante);

  const n = (tipo: Intl.DateTimeFormatPartTypes) =>
    Number(p.find((x) => x.type === tipo)?.value ?? 0);

  // `hour` volta como 24 à meia-noite em alguns runtimes com hour12:false.
  const hora = n("hour") % 24;

  const comoSeFosseUtc = Date.UTC(
    n("year"),
    n("month") - 1,
    n("day"),
    hora,
    n("minute"),
    n("second"),
  );

  // Zera os ms do instante antes de comparar: as partes formatadas não os têm,
  // e sem isso o deslocamento sairia com sobra de até 999ms.
  return comoSeFosseUtc - Math.floor(instante.getTime() / 1000) * 1000;
}

/**
 * O instante exato em que começa, em São Paulo, o dia `2026-08-11`.
 *
 * É o que separa "hoje" de "ontem" na apuração: cortar por UTC jogaria as
 * execuções das 21h às 24h para o dia seguinte, e o relatório de segunda-feira
 * teria três horas de domingo dentro.
 */
export function inicioDoDiaEmSaoPaulo(dia: string) {
  const [ano, mes, data] = dia.split("-").map(Number);
  const palpite = Date.UTC(ano, mes - 1, data, 0, 0, 0);

  // Duas passadas: o deslocamento é medido no palpite, e o palpite corrigido
  // pode cair do outro lado de uma virada de fuso. Na segunda já convergiu.
  let instante = new Date(palpite - deslocamentoDeSaoPaulo(new Date(palpite)));
  instante = new Date(palpite - deslocamentoDeSaoPaulo(instante));
  return instante;
}

/** Soma dias no calendário de São Paulo — `2026-08-11` + 1 = `2026-08-12`. */
export function somarDias(dia: string, dias: number) {
  const [ano, mes, data] = dia.split("-").map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, data + dias));
  return d.toISOString().slice(0, 10);
}

/** O primeiro dia do mês de `2026-08-11` → `2026-08-01`. */
export function primeiroDiaDoMes(dia: string) {
  return `${dia.slice(0, 7)}-01`;
}

/**
 * Mensagem de contexto temporal enviada em **toda** execução de agente.
 *
 * Vai como mensagem, nunca dentro do system prompt: data no prompt muda o
 * prefixo a cada requisição e destrói o cache do provedor, encarecendo todas as
 * mensagens da conversa.
 */
export function mensagemDeContextoTemporal(referencia = new Date()) {
  const { data, hora, diaDaSemana, iso } = agoraEmSaoPaulo(referencia);
  return (
    `Contexto: agora é ${diaDaSemana}, ${data}, ${hora} (horário de São Paulo, ${iso}). ` +
    `Use isto para interpretar "hoje", "amanhã", "semana que vem" e para preencher datas.`
  );
}
