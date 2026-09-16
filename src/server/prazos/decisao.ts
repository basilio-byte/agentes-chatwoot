import {
  ehResolvida,
  humanidadeDoDono,
  podeAgir,
} from "@/server/integrations/chatwoot/regras";

/**
 * Prazos da conversa: "se ninguém responder em N minutos, faça X".
 *
 * Existe para cumprir três promessas que os prompts faziam e o sistema não tinha
 * como cumprir (14/09/2026): "se a Wellen Kelly ou o Alan não responderem em 10
 * min, passe para o Diego", "se o lead parar de responder as perguntas por 10
 * min, passe para o Arthur" e "se o cliente sumir por 1 h, pergunte se precisa
 * de ajuda". O agente só roda quando o cliente escreve, e depois de atribuir a
 * uma pessoa ele fica mudo — não havia quem visse o tempo passar.
 *
 * Este módulo é puro: decide, a partir do estado AO VIVO do Chatwoot, se um prazo
 * vencido ainda deve agir. É aqui que mora a garantia pedida pelo usuário — o
 * sistema não se mete em conversa que uma pessoa já está atendendo —, então toda
 * dúvida pende para NÃO agir. O pior desfecho aceitável é o prazo não fazer nada.
 */

export type TipoDoPrazo = "EQUIPE" | "CLIENTE";

/** O que acontece no vencimento. */
export type AcaoDoPrazo =
  /** EQUIPE: ninguém da equipe respondeu — outra pessoa assume. Nada vai ao cliente. */
  | { tipo: "reatribuir"; atendente: string }
  /**
   * EQUIPE: ninguém da equipe respondeu — a conversa volta para o agente que
   * registrou o prazo, e ele retoma o atendimento sozinho, sem o cliente
   * precisar escrever.
   */
  | { tipo: "voltar_para_o_agente" }
  /** CLIENTE: o cliente parou de responder — UMA mensagem de retomada. */
  | { tipo: "mensagem"; texto: string }
  /** CLIENTE: o cliente parou de responder — uma pessoa assume, com aviso. */
  | { tipo: "atribuir"; atendente: string; aviso: string };

/** Só os campos da mensagem do Chatwoot que a decisão lê. */
export type MensagemDaConversa = {
  id: number;
  /** 0 entrada · 1 saída · 2 atividade · 3 template */
  message_type: number;
  private?: boolean | null;
  /** `user` (pessoa da equipe) · `agent_bot` (robô) · `contact` (cliente). */
  sender?: { type?: string | null } | null;
};

export type ConversaAoVivo = {
  status: string | null;
  assigneeId: number | null;
  /** `User` ou `AgentBot`, de `meta.assignee_type`. */
  assigneeTipo: string | null;
};

export type PrazoParaDecidir = {
  tipo: TipoDoPrazo;
  minutos: number;
  venceEm: Date;
  /** Maior id de mensagem que existia quando o prazo nasceu. */
  referenciaMensagemId: number;
  /** EQUIPE: quem era o dono quando o prazo nasceu. */
  donoId: number | null;
  /** Agente que registrou o prazo. */
  agentId: string;
};

export type DecisaoDoPrazo =
  | { acao: "executar" }
  | { acao: "aguardar" }
  | { acao: "cancelar"; motivo: string }
  | { acao: "descartar"; motivo: string };

export const TOLERANCIA_MINIMA_MINUTOS = 10;

/**
 * Até quanto tempo depois do vencimento ainda vale agir.
 *
 * Worker fora do ar faz o prazo ser visto atrasado. Agir muito depois — a nota
 * de "ninguém respondeu em 10 min" aparecendo uma tarde depois, ou um "ainda
 * está aí?" no dia seguinte — é pior que não agir: descarta e registra.
 */
export function toleranciaEmMinutos(minutos: number): number {
  return Math.max(minutos, TOLERANCIA_MINIMA_MINUTOS);
}

/** A maior id entre as mensagens: o marco de "o que veio depois". */
export function referenciaDasMensagens(mensagens: MensagemDaConversa[]): number {
  return mensagens.reduce((maior, m) => (m.id > maior ? m.id : maior), 0);
}

export type Remetente = "pessoa" | "robo" | "cliente" | "sistema";

/**
 * Quem escreveu a mensagem.
 *
 * ⚠ Mensagem de SAÍDA sem remetente conhecido conta como pessoa. Pode ter vindo
 * de alguém da equipe por um caminho que não se identifica, e contar como pessoa
 * só faz o prazo cair — nunca faz o sistema agir por cima de alguém.
 */
export function remetente(m: MensagemDaConversa): Remetente {
  const tipo = m.sender?.type?.trim().toLowerCase();
  if (tipo === "user") return "pessoa";
  if (tipo === "agent_bot") return "robo";
  if (tipo === "contact") return "cliente";
  if (m.message_type === 0) return "cliente";
  if (m.message_type === 1) return "pessoa";
  return "sistema";
}

/**
 * Os motivos que o prazo grava em `PrazoDeConversa.resultado`.
 *
 * ⚠ **Este texto é DADO no banco, não mensagem de tela.** A tela `/prazos` lê
 * linhas gravadas há semanas para dizer se a pessoa respondeu a tempo ou deixou
 * vencer, e é por estas frases que ela distingue um caso do outro — não há
 * coluna de desfecho, e criar uma não recuperaria o passado.
 * Reescrever uma frase aqui reclassifica o histórico em silêncio. A falha pende
 * para o lado seguro: motivo que a contagem não reconhece vira "sem conclusão"
 * e NUNCA vira falta de alguém.
 */
export const MOTIVO = {
  /** EQUIPE e CLIENTE. */
  resolvida: "a conversa foi resolvida",
  /** EQUIPE: tiraram o dono antes de o prazo vencer. */
  semDono: "a conversa ficou sem dono",
  /** EQUIPE: o robô voltou a ser o dono. */
  naoEhMaisPessoa: "a conversa não está mais com uma pessoa",
  /** EQUIPE: trocou de mãos antes de vencer. */
  outraPessoaAssumiu: "outra pessoa assumiu a conversa",
  /** O oposto exato de perder o prazo: respondeu antes de vencer. */
  equipeEscreveu: "alguém da equipe escreveu na conversa",
  /** CLIENTE. */
  clienteRespondeu: "o cliente respondeu",
  /**
   * ⚠ NÃO é desfecho: o agente registrou outro prazo e este caiu. É o que faz o
   * prazo "zerar a cada resposta" (`registrarPrazo`). Contar isto como uma
   * conversa recebida faria a mesma entrega virar quatro na conta de quem
   * atende — ver `prazos/contagem.ts`.
   */
  substituido: "substituído por um prazo novo",
} as const;

const cancelar = (motivo: string): DecisaoDoPrazo => ({ acao: "cancelar", motivo });

/**
 * O prazo vencido age?
 *
 * Nota interna conta como resposta da equipe: quem escreveu uma nota está com a
 * conversa na mão, e reatribuir por cima dela seria tirar o atendimento de quem
 * já trabalha nele.
 */
export function decidirPrazo(args: {
  prazo: PrazoParaDecidir;
  agora: number;
  conversa: ConversaAoVivo;
  /** Dono da conversa no nosso banco (`Conversation.agentId`), se houver. */
  agentIdDaConversa: string | null;
  mensagens: MensagemDaConversa[];
}): DecisaoDoPrazo {
  const { prazo, agora, conversa, mensagens } = args;

  const vence = prazo.venceEm.getTime();
  if (agora < vence) return { acao: "aguardar" };

  const atrasoMs = agora - vence;
  if (atrasoMs > toleranciaEmMinutos(prazo.minutos) * 60_000) {
    return {
      acao: "descartar",
      motivo: `venceu há ${Math.round(atrasoMs / 60_000)} min — tarde demais para agir`,
    };
  }

  if (ehResolvida(conversa.status)) return cancelar(MOTIVO.resolvida);

  const depois = mensagens.filter((m) => m.id > prazo.referenciaMensagemId);
  const pessoaEscreveu = depois.some((m) => remetente(m) === "pessoa");

  if (prazo.tipo === "EQUIPE") {
    if (conversa.assigneeId == null) return cancelar(MOTIVO.semDono);
    // Só `false` comprovado tira: tipo desconhecido com o mesmo id do dono
    // original continua sendo aquela pessoa, conferida quando o prazo nasceu.
    if (humanidadeDoDono(conversa.assigneeTipo) === false) {
      return cancelar(MOTIVO.naoEhMaisPessoa);
    }
    if (prazo.donoId != null && conversa.assigneeId !== prazo.donoId) {
      return cancelar(MOTIVO.outraPessoaAssumiu);
    }
    if (pessoaEscreveu) return cancelar(MOTIVO.equipeEscreveu);
    return { acao: "executar" };
  }

  // CLIENTE: o bot só fala se a conversa ainda é dele, pela MESMA regra global
  // que vale para toda resposta — dono de tipo desconhecido conta como pessoa.
  if (args.agentIdDaConversa && args.agentIdDaConversa !== prazo.agentId) {
    return cancelar("outro agente assumiu a conversa");
  }
  const veredito = podeAgir({
    status: conversa.status,
    assigneeId: conversa.assigneeId,
    donoEhHumano: humanidadeDoDono(conversa.assigneeTipo),
  });
  if (!veredito.pode) return cancelar(veredito.motivo);
  if (depois.some((m) => remetente(m) === "cliente")) {
    return cancelar(MOTIVO.clienteRespondeu);
  }
  if (pessoaEscreveu) return cancelar(MOTIVO.equipeEscreveu);
  return { acao: "executar" };
}
