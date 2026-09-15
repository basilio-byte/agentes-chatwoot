import { FUSO_SEAHUB } from "@/lib/tempo";

/**
 * O atendimento que acabou de ser resolvido, recortado da conversa do Chatwoot e
 * posto em forma de transcrição para um agente trabalhar sobre ele.
 *
 * Puro de propósito: é aqui que se decide o que é "este atendimento", quem da
 * equipe atendeu e o que o modelo lê — as três coisas que, erradas, fazem o
 * agente avaliar a conversa de agosto, gastar crédito numa conversa que nenhuma
 * pessoa respondeu ou tratar texto do cliente como ordem.
 */

/** Só os campos da mensagem do Chatwoot que este módulo lê. */
export type MensagemDoCiclo = {
  id: number;
  content: string | null;
  /** 0 entrada · 1 saída · 2 atividade · 3 template */
  message_type: number;
  private?: boolean | null;
  /** Segundos desde 1970, como a API manda. */
  created_at?: number;
  sender?: { type?: string | null; name?: string | null } | null;
  attachments?: unknown[] | null;
};

/**
 * Folga entre o instante do evento de resolução e o `created_at` da atividade
 * que o Chatwoot grava para ela — as duas coisas não saem no mesmo segundo.
 */
const FOLGA_EM_SEGUNDOS = 5;

/** Teto do texto de UMA mensagem na transcrição. */
export const TETO_POR_MENSAGEM = 1_500;

/**
 * Teto da transcrição inteira. Acima dele sai o MEIO: o começo (quem atendeu,
 * como se apresentou) e o fim (como terminou) são o que uma avaliação precisa.
 */
export const TETO_DA_TRANSCRICAO = 40_000;

/** Nome de conta dentro da transcrição. Mesmo teto do nome de arquivo na mídia. */
const LIMITE_DO_NOME = 80;

/**
 * ⚠ As atividades vêm no idioma da conta ("Conversa foi marcada como resolvida
 * por Regis Costa", conferido em 15/09/2026). O inglês fica por segurança: conta
 * trocada de idioma não pode fazer o recorte engolir atendimentos inteiros.
 */
const RESOLUCAO = /resolvid|resolved/i;

export function ehAtividadeDeResolucao(m: MensagemDoCiclo): boolean {
  return m.message_type === 2 && RESOLUCAO.test(m.content ?? "");
}

export type Recorte = {
  mensagens: MensagemDoCiclo[];
  /** A resolução anterior está entre as mensagens: o começo foi encontrado. */
  achouOInicio: boolean;
};

/**
 * Só o atendimento que acabou de ser resolvido.
 *
 * O mesmo cliente volta à mesma conversa semanas depois, por outro assunto: sem
 * o recorte, a avaliação de hoje carregaria o atendimento de agosto. O começo é
 * a resolução ANTERIOR; o fim é o instante desta — o "obrigado" que o cliente
 * manda um minuto depois já é outra coisa.
 */
export function recortarAtendimento(
  mensagens: MensagemDoCiclo[],
  resolvidaEm: number,
): Recorte {
  const ate = [...mensagens]
    .sort((a, b) => a.id - b.id)
    .filter(
      (m) =>
        typeof m.created_at !== "number" ||
        m.created_at <= resolvidaEm + FOLGA_EM_SEGUNDOS,
    );

  for (let i = ate.length - 1; i >= 0; i--) {
    const m = ate[i];
    if (
      ehAtividadeDeResolucao(m) &&
      typeof m.created_at === "number" &&
      m.created_at < resolvidaEm - FOLGA_EM_SEGUNDOS
    ) {
      return { mensagens: ate.slice(i + 1), achouOInicio: true };
    }
  }

  return { mensagens: ate, achouOInicio: false };
}

/** Sem acento, caixa nem espaço sobrando: " Wellen Kelly" e "wellen kelly" são a mesma conta. */
function chaveDoNome(nome: string) {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Nome de conta ou de contato, reduzido ao que não consegue fingir ser marcação.
 * Nome de contato é escolhido pelo próprio cliente.
 */
export function limparNome(bruto: string | null | undefined): string {
  const limpo = (bruto ?? "").replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  if (limpo.length <= LIMITE_DO_NOME) return limpo;
  return `${[...limpo].slice(0, LIMITE_DO_NOME - 1).join("").trimEnd()}…`;
}

/**
 * As pessoas da equipe que responderam ao cliente neste atendimento.
 *
 * Conta só mensagem PÚBLICA de saída com remetente `user`. Nota interna não é
 * atendimento, é conversa da equipe, e robô não é pessoa. As contas de automação
 * saem porque escrevem como gente: o n8n manda o NPS e as notas de template com
 * o token do Basílio (decisão do usuário, 15/09/2026).
 *
 * ⚠ Remetente de tipo desconhecido NÃO conta — o oposto dos prazos, e de
 * propósito. Lá, contar como pessoa só faz o sistema deixar de agir; aqui faria
 * gastar uma execução numa conversa que talvez ninguém tenha atendido.
 */
export function quemAtendeu(
  mensagens: MensagemDoCiclo[],
  contasDeAutomacao: string[],
): string[] {
  const ignoradas = new Set(contasDeAutomacao.map(chaveDoNome));
  const nomes = new Map<string, string>();

  for (const m of mensagens) {
    if (m.message_type !== 1 || m.private) continue;
    if (m.sender?.type?.trim().toLowerCase() !== "user") continue;

    const nome = limparNome(m.sender?.name);
    if (!nome || ignoradas.has(chaveDoNome(nome))) continue;
    nomes.set(chaveDoNome(nome), nome);
  }

  return [...nomes.values()];
}

function tiposDosAnexos(brutos: unknown[] | null | undefined): string[] {
  return (brutos ?? [])
    .filter((a): a is { file_type?: unknown } => typeof a === "object" && a !== null)
    .map((a) =>
      typeof a.file_type === "string" && a.file_type.trim()
        ? a.file_type.trim().toLowerCase()
        : "arquivo",
    );
}

function quandoEmSaoPaulo(segundosDesde1970?: number): string {
  if (typeof segundosDesde1970 !== "number") return "--/-- --:--";

  const partes = new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO_SEAHUB,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(segundosDesde1970 * 1000));
  const parte = (tipo: Intl.DateTimeFormatPartTypes) =>
    partes.find((p) => p.type === tipo)?.value ?? "";

  return `${parte("day")}/${parte("month")} ${parte("hour")}:${parte("minute")}`;
}

/**
 * Quem fala, do jeito que a avaliação precisa separar.
 *
 * A conta de automação aparece como tal, e não como atendente: é o que impede o
 * modelo de avaliar o "vendedor Basílio" pelo NPS que o n8n mandou.
 */
function falante(m: MensagemDoCiclo, automacao: Set<string>): string {
  const nome = limparNome(m.sender?.name);
  const tipo = m.sender?.type?.trim().toLowerCase();

  if (m.message_type === 2) return "Sistema";
  if (m.private) return nome ? `Nota interna (${nome})` : "Nota interna";
  if (m.message_type === 0 || tipo === "contact") return "Cliente";
  if (tipo === "agent_bot") return "Robô";
  if (tipo === "user") {
    if (nome && automacao.has(chaveDoNome(nome))) return `Automação (${nome})`;
    return nome ? `Atendente (${nome})` : "Atendente";
  }
  return "Equipe";
}

/**
 * O texto de uma mensagem dentro da cerca.
 *
 * Colchete vira parêntese pelo mesmo motivo da leitura de mídia: a cerca só
 * segura se todo colchete que sobra dentro dela for nosso. Aqui dá para fazer o
 * que no atendimento não dá — isto não é mensagem a ser respondida, é registro,
 * e trocar o colchete do cliente não muda o que ele quis dizer.
 */
function textoDaMensagem(m: MensagemDoCiclo): string {
  const texto = (m.content ?? "")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s*\n+\s*/g, " / ")
    .replace(/[ \t]+/g, " ")
    .trim();

  const cortado =
    texto.length > TETO_POR_MENSAGEM
      ? `${[...texto].slice(0, TETO_POR_MENSAGEM).join("")}… (mensagem cortada)`
      : texto;

  const anexos = tiposDosAnexos(m.attachments);
  const sufixo = anexos.length > 0 ? `(anexo: ${anexos.join(", ")})` : "";

  return [cortado, sufixo].filter(Boolean).join(" ");
}

export const ABERTURA_DA_TRANSCRICAO = "[transcrição do atendimento]";
export const FIM_DA_TRANSCRICAO = "[fim da transcrição]";

/**
 * A transcrição cercada.
 *
 * `completa` falso quer dizer que a leitura parou antes da resolução anterior —
 * conversa longa demais para as páginas lidas —, e isso é dito ao modelo: sem o
 * aviso, ele avaliaria a apresentação de quem atendeu por um começo que não viu.
 */
export function montarTranscricao(
  mensagens: MensagemDoCiclo[],
  contasDeAutomacao: string[],
  completa: boolean,
): string {
  const automacao = new Set(contasDeAutomacao.map(chaveDoNome));
  const linhas: string[] = [];

  for (const m of mensagens) {
    const texto = textoDaMensagem(m);
    if (!texto) continue;
    linhas.push(`${quandoEmSaoPaulo(m.created_at)} · ${falante(m, automacao)}: ${texto}`);
  }

  let corpo = linhas.join("\n");
  if (corpo.length > TETO_DA_TRANSCRICAO) {
    const cabeca = Math.floor(TETO_DA_TRANSCRICAO / 4);
    const cauda = TETO_DA_TRANSCRICAO - cabeca;
    corpo = [
      corpo.slice(0, cabeca),
      "(… trecho do meio cortado: o atendimento é maior do que cabe …)",
      corpo.slice(-cauda),
    ].join("\n");
  }

  return [
    ABERTURA_DA_TRANSCRICAO,
    ...(completa
      ? []
      : ["(o começo deste atendimento não foi lido: a conversa é longa demais)"]),
    corpo || "(nenhuma mensagem com texto neste atendimento)",
    FIM_DA_TRANSCRICAO,
  ].join("\n");
}

function quandoCompleto(segundosDesde1970: number): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO_SEAHUB,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(segundosDesde1970 * 1000))
    .replace(",", "");
}

/**
 * A mensagem que abre o turno.
 *
 * O cabeçalho é todo nosso; o nome e o telefone do contato, que vêm do cadastro
 * do cliente, passam pela mesma limpeza da transcrição antes de entrar nele.
 */
export function mensagemDaConversaEncerrada(args: {
  conversationId: number;
  link: string | null;
  resolvidaEm: number;
  contatoNome: string | null;
  telefone: string | null;
  atendentes: string[];
  transcricao: string;
}): string {
  const telefone = (args.telefone ?? "").replace(/[^\d+\s()-]/g, "").trim();

  return [
    "[Conversa encerrada no Chatwoot — o sistema acionou este agente em segundo plano. Nada do que você escrever vai para o cliente.]",
    `Conversa: #${args.conversationId}`,
    ...(args.link ? [`Link: ${args.link}`] : []),
    `Resolvida em: ${quandoCompleto(args.resolvidaEm)}`,
    `Contato: ${limparNome(args.contatoNome) || "sem nome"}`,
    `Telefone do contato: ${telefone || "não informado"}`,
    `Quem da equipe respondeu ao cliente: ${
      args.atendentes.length > 0 ? args.atendentes.join(", ") : "ninguém"
    }`,
    "",
    args.transcricao,
  ].join("\n");
}
