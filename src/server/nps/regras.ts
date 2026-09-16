import { eventoChatwootSchema } from "@/server/integrations/chatwoot/eventos";
import type { MensagemChatwoot } from "@/server/integrations/chatwoot/client";
import { ehResolvida, humanidadeDoDono } from "@/server/integrations/chatwoot/regras";
import type { NpsConfig } from "./config";

/**
 * As decisões da pesquisa de satisfação que não dependem de rede nem de banco:
 * o que é nota, quem escreveu depois da pesquisa, o que o cliente lê. Puro de
 * propósito, como `prazos/decisao.ts`.
 */

/** O que costuma vir em volta da nota e não muda o que ela é. */
const ENFEITES = new Set(["nota", "minha", "é", "e", "estrela", "estrelas"]);

const POR_EXTENSO: Record<string, number> = {
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  três: 3,
  quatro: 4,
  cinco: 5,
};

const ESTRELA = /⭐|★|🌟/gu;

/**
 * A nota, quando a mensagem é SÓ a nota.
 *
 * Decisão do usuário (15/09/2026): nota é uma mensagem que é um número de 1 a 5.
 * O Switch do n8n casava qualquer mensagem que CONTIVESSE o dígito, e "chego dia
 * 15" podia receber o "sentimos muito" da nota 1 e ter a conversa resolvida.
 * Aqui só passa o que cerca a nota sem mudar o que ela é: pontuação, emoji,
 * "nota", "estrelas", "5/5", o número por extenso e as estrelas copiadas da
 * própria pergunta ("5- ⭐⭐⭐⭐⭐"), que precisam bater com o número.
 *
 * "5, obrigado pelo atendimento" NÃO é nota: tem texto além dela.
 */
export function lerNota(texto: string | null | undefined): number | null {
  const bruto = (texto ?? "")
    .normalize("NFC")
    .toLowerCase()
    // Seletor de variação e moldura de tecla: "5️⃣" é um 5.
    .replace(/[️⃣]/g, "")
    .trim();
  if (!bruto) return null;

  const estrelas = bruto.match(ESTRELA)?.length ?? 0;
  const palavras = bruto
    .replace(ESTRELA, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[.,;:!?()[\]{}\-–—=*_"'´`~]+/g, " ")
    .split(/\s+/)
    .filter((p) => p && !ENFEITES.has(p));

  // Só estrelas: "⭐⭐⭐⭐".
  if (palavras.length === 0) return estrelas >= 1 && estrelas <= 5 ? estrelas : null;
  if (palavras.length !== 1) return null;

  const [palavra] = palavras;
  const nota = /^[1-5]$/.test(palavra)
    ? Number(palavra)
    : /^[1-5]\/5$/.test(palavra)
      ? Number(palavra[0])
      : (POR_EXTENSO[palavra] ?? null);
  if (nota === null) return null;

  // Uma estrela é unidade ("5⭐"); mais de uma é a opção copiada, e tem de bater.
  return estrelas <= 1 || estrelas === nota ? nota : null;
}

export type MensagemDoCliente = {
  conversationId: number;
  /** Id da mensagem no Chatwoot: "depois da nota" é id maior que este. */
  mensagemId: number | null;
  texto: string;
};

/**
 * A mensagem que o CLIENTE acabou de mandar, se a entrega for isso.
 *
 * As mesmas recusas de `decidirSeResponde` para o que não é o cliente falando —
 * nota privada, saída, remetente que não é contato — e nenhuma das outras: a
 * resposta à pesquisa vale com a conversa atribuída ou resolvida, porque quem
 * perguntou foi o sistema.
 */
export function mensagemDoCliente(bruto: unknown): MensagemDoCliente | null {
  const lido = eventoChatwootSchema.safeParse(bruto);
  if (!lido.success) return null;
  const evento = lido.data;

  if (evento.event !== "message_created") return null;
  if (evento.private === true || evento.message_type !== "incoming") return null;
  const tipo = evento.sender?.type?.toLowerCase();
  if (tipo && tipo !== "contact") return null;

  const conversationId = evento.conversation?.id;
  if (!conversationId) return null;

  const id = Number(evento.id);
  return {
    conversationId,
    mensagemId: Number.isInteger(id) && id > 0 ? id : null,
    texto: (evento.content ?? "").trim(),
  };
}

type MensagemLida = Pick<MensagemChatwoot, "id" | "message_type" | "sender">;

/**
 * Quem escreveu na conversa depois de uma mensagem: o cliente, alguém da equipe
 * (inclusive nota interna) ou só robô.
 *
 * "Depois" é por id, como nos prazos. Saída sem remetente conhecido conta como
 * equipe: na dúvida, a pesquisa não age por cima de ninguém.
 */
export function quemEscreveuDepois(mensagens: MensagemLida[], depoisDe: number) {
  let cliente = false;
  let equipe = false;

  for (const m of mensagens) {
    if (m.id <= depoisDe) continue;
    if (m.message_type === 0) cliente = true;
    else if (m.message_type === 1 || m.message_type === 3) {
      if (m.sender?.type?.toLowerCase() !== "agent_bot") equipe = true;
    }
  }

  return { cliente, equipe };
}

export type ConversaAoVivo = {
  status: string | null;
  assigneeId: number | null;
  assigneeTipo: string | null;
};

/**
 * Por que a pesquisa não deve mais agir na conversa, ou `null` se pode.
 *
 * A garantia é a dos prazos: nunca se meter em atendimento de pessoa. Dono de
 * tipo desconhecido conta como pessoa.
 */
export function motivoParaNaoAgir(args: {
  conversa: ConversaAoVivo;
  mensagens: MensagemLida[];
  depoisDe: number;
  /**
   * Mensagem do cliente depois do marco também impede. Antes da nota, sim: ele
   * falou de outra coisa. Depois dela, é complemento e não impede.
   */
  clienteImpede: boolean;
}): string | null {
  if (ehResolvida(args.conversa.status)) return "a conversa foi resolvida por alguém";
  if (
    args.conversa.assigneeId != null &&
    humanidadeDoDono(args.conversa.assigneeTipo) !== false
  ) {
    return "uma pessoa assumiu a conversa";
  }

  const quem = quemEscreveuDepois(args.mensagens, args.depoisDe);
  if (quem.equipe) return "alguém da equipe escreveu na conversa";
  if (args.clienteImpede && quem.cliente) return "o cliente escreveu outra coisa";
  return null;
}

export function respostaDaNota(nota: number, textos: NpsConfig["textos"]): string {
  return nota <= 3 ? textos.notaBaixa : textos.notaAlta;
}

/** Nota interna quando não há task para gravar (decisão do usuário, 15/09/2026). */
export function notaSemCrm(nota: number, problemas: string[]): string {
  return [
    `⭐ Pesquisa de satisfação: o cliente deu nota ${nota}.`,
    `A nota não foi gravada no CRM${problemas.length > 0 ? ` — ${problemas.join("; ")}` : ""}.`,
  ].join("\n");
}

/** O rastro da pesquisa, lido na tela: partes em ordem, a mais nova no fim. */
export function juntarRastro(partes: (string | null | undefined)[]): string | null {
  const texto = partes.filter((p): p is string => Boolean(p?.trim())).join(" · ");
  if (!texto) return null;
  return texto.length > 2000 ? `…${texto.slice(-1999)}` : texto;
}
