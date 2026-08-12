/**
 * CSV da apuração — uma linha por execução, para a planilha fazer o resto.
 *
 * Separador `;` e decimal com vírgula porque o destino é o Excel em português:
 * com `,` de separador ele joga a linha inteira numa célula só, e com `.` de
 * decimal ele lê `0.0119` como texto e a soma dá zero. Fora do Excel, quem
 * consome CSV configura o separador; dentro dele, ninguém configura nada.
 */

export type LinhaCsv = {
  createdAt: Date;
  agente: string;
  model: string | null;
  source: string;
  status: string;
  chatwootConversationId: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  latencyMs: number | null;
  iterations: number;
  erro: string | null;
};

const COLUNAS = [
  "Data/hora (São Paulo)",
  "Agente",
  "Modelo",
  "Fonte",
  "Status",
  "Conversa no Chatwoot",
  "Tokens entrada",
  "Tokens saída",
  "Tokens de cache",
  "Custo (USD)",
  "Latência (ms)",
  "Iterações",
  "Erro",
];

/** Escapa aspas e envolve o campo quando ele tem separador, aspas ou quebra. */
function celula(valor: string) {
  return /[;"\n\r]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
}

function decimal(valor: number, casas: number) {
  return valor.toFixed(casas).replace(".", ",");
}

/**
 * `2026-08-11 19:52:03` no fuso de São Paulo. Sem "T" e sem fuso no texto: é
 * assim que o Excel reconhece como data em vez de tratar como string.
 */
function dataHora(instante: Date, formatador: Intl.DateTimeFormat) {
  const p = formatador.formatToParts(instante);
  const v = (t: Intl.DateTimeFormatPartTypes) =>
    p.find((x) => x.type === t)?.value ?? "";
  return `${v("year")}-${v("month")}-${v("day")} ${v("hour")}:${v("minute")}:${v("second")}`;
}

export function paraCsv(linhas: LinhaCsv[], fuso: string): string {
  const formatador = new Intl.DateTimeFormat("en-CA", {
    timeZone: fuso,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const corpo = linhas.map((l) =>
    [
      dataHora(l.createdAt, formatador),
      l.agente,
      // Vazio, e não "desconhecido": a planilha filtra melhor por célula vazia,
      // e inventar um rótulo aqui viraria uma categoria falsa na tabela dinâmica.
      l.model ?? "",
      l.source,
      l.status,
      l.chatwootConversationId?.toString() ?? "",
      String(l.inputTokens),
      String(l.outputTokens),
      String(l.cacheReadTokens),
      // Seis casas: o custo de um turno barato é da ordem de US$ 0,0007, e
      // arredondar para centavos zeraria a coluna inteira.
      decimal(l.costUsd, 6),
      l.latencyMs?.toString() ?? "",
      String(l.iterations),
      (l.erro ?? "").replace(/\s+/g, " ").trim(),
    ]
      .map(celula)
      .join(";"),
  );

  // CRLF e BOM: sem eles o Excel abre acento como caractere quebrado.
  return `﻿${[COLUNAS.join(";"), ...corpo].join("\r\n")}\r\n`;
}

/** `consumo-2026-07-13-a-2026-08-11.csv` */
export function nomeDoArquivo(primeiroDia: string | null, ultimoDia: string | null) {
  if (!primeiroDia) return `consumo-ate-${ultimoDia ?? "hoje"}.csv`;
  return `consumo-${primeiroDia}-a-${ultimoDia}.csv`;
}
