import { limparNome, quandoCompleto } from "@/server/conversa-encerrada/ciclo";

/**
 * O que o agente e a equipe leem quando um checkbox aciona o agente.
 *
 * Puro de propósito, como `ciclo.ts`: o cabeçalho é todo nosso, e o que vem do
 * cadastro do cliente (nome, telefone) passa pela mesma limpeza da transcrição
 * antes de entrar nele.
 */

/**
 * Janela em que uma task deste agente nesta conversa conta como já registrada.
 *
 * A mesma do Olho de Tudo para "task recente". No WhatsApp a conversa do
 * Chatwoot dura meses: sem janela, a task do atendimento de maio barraria o
 * registro do lead de setembro.
 */
export const DIAS_DE_REGISTRO = 30;

export type TaskRegistrada = { url: string | null; nome: string | null; em: Date };

/**
 * As tasks que o agente já criou nesta conversa, lidas das execuções.
 *
 * Só conta `criada: true` — o retorno de `clickup_criar_tarefa` quando a task
 * existe de fato. Recusa, erro e retorno em texto não criaram nada.
 */
export function tasksRegistradas(
  chamadas: { output: unknown; createdAt: Date }[],
): TaskRegistrada[] {
  return chamadas.flatMap((chamada) => {
    const saida = chamada.output;
    if (typeof saida !== "object" || saida === null || Array.isArray(saida)) return [];

    const { criada, url, nome } = saida as Record<string, unknown>;
    if (criada !== true) return [];

    return [
      {
        url: typeof url === "string" ? url : null,
        nome: typeof nome === "string" ? nome : null,
        em: chamada.createdAt,
      },
    ];
  });
}

/** A mensagem que abre o turno. */
export function mensagemDaConversaMarcada(args: {
  atributo: string;
  conversationId: number;
  link: string | null;
  /** Segundos desde 1970, com fração. */
  marcadoEm: number;
  contatoNome: string | null;
  telefone: string | null;
  /** O responsável da conversa no Chatwoot — já conferido como pessoa. */
  dono: string | null;
  atendentes: string[];
  transcricao: string;
}): string {
  const telefone = (args.telefone ?? "").replace(/[^\d+\s()-]/g, "").trim();

  return [
    "[Checkbox marcado no Chatwoot — alguém da equipe marcou um campo nesta conversa e o sistema acionou este agente em segundo plano. Nada do que você escrever vai para o cliente.]",
    `Checkbox marcado: ${args.atributo}`,
    `Conversa: #${args.conversationId}`,
    ...(args.link ? [`Link: ${args.link}`] : []),
    `Marcado em: ${quandoCompleto(Math.floor(args.marcadoEm))}`,
    `Contato: ${limparNome(args.contatoNome) || "sem nome"}`,
    `Telefone do contato: ${telefone || "não informado"}`,
    `Dono da conversa no Chatwoot: ${limparNome(args.dono) || "ninguém"}`,
    `Quem da equipe respondeu ao cliente: ${
      args.atendentes.length > 0 ? args.atendentes.join(", ") : "ninguém"
    }`,
    "",
    args.transcricao,
  ].join("\n");
}

/**
 * Nota interna quando a conversa não tem uma pessoa responsável.
 *
 * Não afirma que o checkbox foi desmarcado: desmarcar pode ter falhado, e a
 * nota seria lida como fato.
 */
export function notaSemDono(args: { atributo: string; agente: string }): string {
  return `${args.agente} não registrou nada com o checkbox "${args.atributo}": a conversa não tem uma pessoa responsável. Atribua a conversa a quem atendeu e marque o checkbox de novo.`;
}

/** Nota interna quando este agente já registrou nesta conversa. */
export function notaJaRegistrada(args: {
  atributo: string;
  agente: string;
  tasks: TaskRegistrada[];
}): string {
  const lista = args.tasks
    .map(
      (t) =>
        `${t.url ?? (limparNome(t.nome) || "task sem link")} (${quandoCompleto(
          Math.floor(t.em.getTime() / 1000),
        )})`,
    )
    .join("; ");

  return `${args.agente} não criou task nova com o checkbox "${args.atributo}": já há task criada por ele nesta conversa nos últimos ${DIAS_DE_REGISTRO} dias — ${lista}. Se precisar de outra, crie à mão.`;
}
