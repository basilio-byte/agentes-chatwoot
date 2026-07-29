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
