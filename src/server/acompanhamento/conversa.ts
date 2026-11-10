import { remetente, type MensagemDaConversa } from "@/server/prazos/decisao";

import type { Remetente } from "./regras";

/**
 * O lado Chatwoot do acompanhamento: em qual conversa falar, e quem estava
 * atendendo.
 *
 * ⚠ Nada aqui abre conversa NOVA. O Diego garantiu que a conversa existe e
 * está aberta enquanto o processo roda (10/11/2026); e abrir conversa por
 * conta própria, numa caixa de WhatsApp oficial, é o tipo de coisa que só se
 * faz com decisão explícita — o alerta de saldo faz isso na caixa 31, que é
 * outra história. Sem conversa, a rodada registra e segue.
 */

/** A caixa do WhatsApp oficial, onde o cliente conversa com o vendedor. */
export const CAIXA_DO_CLIENTE = 29;

export type ConversaDoContato = {
  id: number;
  caixaId: number | null;
  status: string | null;
  ultimaAtividadeEm: number | null;
};

/**
 * Em qual conversa o acompanhamento fala.
 *
 * A aberta mais recente daquela caixa. Não havendo nenhuma aberta, a mais
 * recente mesmo resolvida — essa é reaberta e devolvida a quem atendia, que é
 * o que o Diego pediu. Conversa de outra caixa nunca entra: o cliente
 * conversa com o vendedor no WhatsApp oficial, e responder noutro número seria
 * começar um fio paralelo.
 */
export function escolherConversa(
  conversas: ConversaDoContato[],
  caixaId = CAIXA_DO_CLIENTE,
): { conversa: ConversaDoContato; precisaReabrir: boolean } | null {
  const daCaixa = conversas.filter((c) => c.caixaId === caixaId);
  if (!daCaixa.length) return null;

  const porRecencia = [...daCaixa].sort(
    (a, b) => (b.ultimaAtividadeEm ?? b.id) - (a.ultimaAtividadeEm ?? a.id),
  );

  const viva = porRecencia.find((c) => (c.status ?? "").toLowerCase() !== "resolved");
  if (viva) return { conversa: viva, precisaReabrir: false };

  return { conversa: porRecencia[0], precisaReabrir: true };
}

/**
 * A mensagem do Chatwoot como esta rodada a lê: o que os prazos já leem, mais
 * o instante e o NOME de quem escreveu (é por ele que a conversa reaberta
 * volta a quem atendia).
 */
export type FalaDaConversa = Omit<MensagemDaConversa, "sender"> & {
  created_at?: number | null;
  sender?: { type?: string | null; name?: string | null } | null;
};

/**
 * A última fala da conversa — quem foi e quando.
 *
 * ⚠ **Mensagem de ATIVIDADE não é fala.** "Conversa resolvida por Fulano" e
 * "atribuída a Beltrano" têm `message_type: 2` e nenhum remetente; contá-las
 * faria o sistema achar que alguém acabou de escrever e adiar para sempre.
 *
 * ⚠ **Nota interna CONTA.** Ela não chega ao cliente, mas significa que uma
 * pessoa está trabalhando aquela conversa agora — e é exatamente disso que a
 * trava trata.
 */
export function ultimaFala(
  mensagens: FalaDaConversa[],
): { deQuem: Remetente; em: Date } | null {
  const falas = mensagens.filter((m) => m.message_type !== 2);
  if (!falas.length) return null;

  const ultima = falas.reduce((maior, m) => (m.id > maior.id ? m : maior), falas[0]);
  const segundos = ultima.created_at;

  return {
    deQuem: comoRemetente(ultima),
    // Sem `created_at` não dá para medir o intervalo, e a trava existe
    // justamente para o caso recente: trata como AGORA, que é o lado seguro.
    em: typeof segundos === "number" ? new Date(segundos * 1000) : new Date(),
  };
}

function comoRemetente(m: MensagemDaConversa): Remetente {
  switch (remetente(m)) {
    case "pessoa":
      return "equipe";
    case "robo":
      return "robo";
    case "cliente":
      return "cliente";
    default:
      return "desconhecido";
  }
}

/**
 * O nome de quem atendeu por último — é a ele que a conversa reaberta volta.
 *
 * ⚠ **Só pessoa conta.** O robô escreve na conversa o tempo todo, e devolver a
 * conversa "ao robô" é deixá-la sem dono. Sem ninguém no histórico, quem
 * decide é quem chamou: a rodada deixa a conversa como está e registra.
 */
export function ultimoAtendente(mensagens: FalaDaConversa[]): string | null {
  const dePessoa = mensagens
    .filter((m) => remetente(m) === "pessoa")
    .sort((a, b) => b.id - a.id);

  for (const m of dePessoa) {
    const nome = m.sender?.name?.trim();
    if (nome) return nome;
  }
  return null;
}
