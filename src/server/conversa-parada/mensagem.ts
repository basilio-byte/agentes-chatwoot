import { limparNome, quandoCompleto } from "@/server/conversa-encerrada/ciclo";

/**
 * O que o agente lê quando o relógio o aciona sobre uma conversa parada.
 *
 * Puro, como o da conversa marcada: o cabeçalho é todo nosso, e o que vem do
 * cadastro do cliente passa pela mesma limpeza da transcrição antes de entrar
 * nele — nome de contato é texto que um terceiro escolheu.
 */
export function mensagemDaConversaParada(args: {
  conversationId: number;
  link: string | null;
  contatoNome: string | null;
  telefone: string | null;
  /** O responsável no Chatwoot — já conferido como pessoa. */
  dono: string | null;
  atendentes: string[];
  /** Instante da última mensagem pública, em segundos. */
  ultimaMensagemEm: number;
  /** Quem mandou a última mensagem pública. */
  ultimoFalante: "cliente" | "equipe";
  horasParadas: number;
  transcricao: string;
}): string {
  const telefone = (args.telefone ?? "").replace(/[^\d+\s()-]/g, "").trim();
  const ladoQueParou =
    args.ultimoFalante === "cliente"
      ? "o CLIENTE falou por último e ninguém da equipe respondeu desde então"
      : "a EQUIPE falou por último e o cliente não respondeu desde então";

  return [
    "[Conversa parada — o sistema varreu as conversas abertas e acionou este agente em segundo plano. Quem atende é a pessoa responsável abaixo, e ela continua atendendo. Nada do que você escrever vai para o cliente.]",
    `Conversa: #${args.conversationId}`,
    ...(args.link ? [`Link: ${args.link}`] : []),
    `Contato: ${limparNome(args.contatoNome) || "sem nome"}`,
    `Telefone do contato: ${telefone || "não informado"}`,
    `Responsável pela conversa: ${limparNome(args.dono) || "ninguém"}`,
    `Quem da equipe respondeu ao cliente: ${
      args.atendentes.length > 0 ? args.atendentes.join(", ") : "ninguém"
    }`,
    `Última mensagem: ${quandoCompleto(args.ultimaMensagemEm)} — ${ladoQueParou}.`,
    `Parada há mais de ${args.horasParadas} hora(s).`,
    "",
    args.transcricao,
  ].join("\n");
}

/**
 * Carimbo da nota, posto pelo SISTEMA e não pelo modelo.
 *
 * O prompt pede que a nota comece assim, mas prompt decora e sistema garante:
 * nota sem origem, no meio do fio da conversa, é indistinguível de alguém da
 * equipe ter afirmado aquilo — a mesma lição do carimbo das anotações do
 * Conexa. Se o modelo escrever o carimbo, não se repete.
 */
export const CARIMBO = "Sugestão comercial (automática):";

export function carimbar(texto: string): string {
  const limpo = texto.trim();
  const comecoNormalizado = limpo.slice(0, CARIMBO.length).toLowerCase();
  if (comecoNormalizado === CARIMBO.toLowerCase()) return limpo;
  return `${CARIMBO}\n${limpo}`;
}
