import type { MensagemChatwoot } from "@/server/integrations/chatwoot/client";
import { FUSO_SEAHUB } from "@/lib/tempo";

/**
 * A janela de 24 h do WhatsApp oficial: regras puras.
 *
 * A Meta só deixa a empresa mandar mensagem livre até 24 h depois da última
 * mensagem do CLIENTE. Na caixa 29 (NotificaMe, `Channel::Api`) o Chatwoot não
 * sabe disso — para ele a caixa é uma API qualquer, e o campo de resposta fica
 * aberto para sempre. Quem diz à equipe se a mensagem escrita ainda chega são
 * duas etiquetas: `meta_janela_aberta` é posta pela automação 31 do próprio
 * Chatwoot a cada mensagem do cliente; `meta_janela_fechada` é posta aqui.
 *
 * Substitui o ramo "janela fechada" do fluxo "Follow - UPs Janela de Conversas"
 * do n8n, que desde a edição de 28/08/2026 apagava a própria tabela a cada
 * rodada e passou a fechar UMA conversa por dia (21/09/2026: 92 das 120
 * conversas abertas da caixa 29 marcadas como abertas com a janela vencida).
 */

export const ETIQUETA_ABERTA = "meta_janela_aberta";
export const ETIQUETA_FECHADA = "meta_janela_fechada";

export const HORAS_DA_JANELA = 24;
const JANELA_EM_SEGUNDOS = HORAS_DA_JANELA * 3600;

/**
 * Como a nota começa. Não é enfeite: nota sem origem, no meio de uma conversa
 * que uma pessoa está atendendo, se lê como se alguém da equipe tivesse escrito
 * aquilo — a mesma lição do carimbo da conversa parada.
 */
export const MARCA_DA_NOTA = "⏳ Janela do WhatsApp:";

type MensagemLida = Pick<MensagemChatwoot, "id" | "message_type" | "private" | "created_at">;

export type EntradaDoCliente = { id: number; em: number };

/**
 * A última mensagem do cliente entre as lidas, em qualquer ordem.
 *
 * Só `message_type` 0 conta: saída, atividade, modelo e nota não abrem janela
 * nenhuma — a Meta mede pelo que o cliente mandou.
 */
export function ultimaDoCliente(mensagens: MensagemLida[]): EntradaDoCliente | null {
  let ultima: EntradaDoCliente | null = null;
  for (const m of mensagens) {
    if (m.message_type !== 0 || m.private === true) continue;
    if (typeof m.created_at !== "number") continue;
    if (!ultima || m.created_at > ultima.em || (m.created_at === ultima.em && m.id > ultima.id)) {
      ultima = { id: m.id, em: m.created_at };
    }
  }
  return ultima;
}

/** A mensagem do cliente escrita por último, entre duas. */
export function maisRecente(
  a: EntradaDoCliente | null,
  b: EntradaDoCliente | null,
): EntradaDoCliente | null {
  if (!a) return b;
  if (!b) return a;
  return b.em > a.em || (b.em === a.em && b.id > a.id) ? b : a;
}

/** O que a leitura das mensagens achou, andando para trás a partir da mais recente. */
export type LeituraDaJanela = {
  ultima: EntradaDoCliente | null;
  /** Chegou à primeira mensagem da conversa sem achar nada do cliente. */
  leuAteOComeco: boolean;
  /** A mensagem mais antiga lida, em segundos. */
  maisAntigaEm: number | null;
};

export type Janela =
  | { estado: "aberta"; fechaEm: number }
  | { estado: "fechando"; fechaEm: number }
  /** `fechaEm` nulo: o cliente não escreveu no que foi lido — a janela nunca abriu ali. */
  | { estado: "fechada"; fechaEm: number | null }
  | { estado: "indeterminada" };

/**
 * Em que pé está a janela agora.
 *
 * "Fechando" é o trecho em que a nota sai: os últimos `minutosDeAviso` antes de
 * fechar. Sem mensagem do cliente no que foi lido, a janela só é dada como
 * fechada quando isso é CERTO — a leitura chegou ao começo da conversa, ou já
 * passou de 24 h para trás. Senão fica indeterminada, e nada é feito: uma
 * etiqueta de "fechada" errada faria alguém ligar para um cliente que ainda
 * podia receber mensagem, ou pior, deixar de escrever.
 */
export function estadoDaJanela(args: {
  leitura: LeituraDaJanela;
  agoraEmSegundos: number;
  minutosDeAviso: number;
}): Janela {
  const { leitura, agoraEmSegundos: agora } = args;

  if (!leitura.ultima) {
    const passouDaJanela =
      leitura.maisAntigaEm != null && leitura.maisAntigaEm <= agora - JANELA_EM_SEGUNDOS;
    return leitura.leuAteOComeco || passouDaJanela
      ? { estado: "fechada", fechaEm: null }
      : { estado: "indeterminada" };
  }

  const fechaEm = leitura.ultima.em + JANELA_EM_SEGUNDOS;
  if (agora >= fechaEm) return { estado: "fechada", fechaEm };
  if (agora >= fechaEm - args.minutosDeAviso * 60) return { estado: "fechando", fechaEm };
  return { estado: "aberta", fechaEm };
}

export function temEtiquetaDeFechada(etiquetas: readonly string[]): boolean {
  return etiquetas.includes(ETIQUETA_FECHADA) && !etiquetas.includes(ETIQUETA_ABERTA);
}

/**
 * Precisa ler as mensagens desta conversa? Descarta de graça o que a listagem
 * já responde, antes de gastar uma chamada por conversa.
 *
 * - Já marcada como fechada: nada a fazer. Quando o cliente escrever, a
 *   automação 31 do Chatwoot troca para aberta, e ela volta a ser olhada.
 * - A última mensagem é do cliente e é recente: a janela está aberta e longe de
 *   fechar. ⚠ Só vale quando a última é DO CLIENTE: se for da equipe ou uma
 *   nota, o cliente pode estar calado há dias.
 */
export function precisaLer(args: {
  etiquetas: readonly string[];
  ultimaMensagem: { tipo: number | null; privada: boolean; criadaEm: number | null } | null;
  agoraEmSegundos: number;
  minutosDeAviso: number;
}): boolean {
  if (temEtiquetaDeFechada(args.etiquetas)) return false;

  const ultima = args.ultimaMensagem;
  if (ultima && ultima.tipo === 0 && !ultima.privada && ultima.criadaEm != null) {
    const avisaEm = ultima.criadaEm + JANELA_EM_SEGUNDOS - args.minutosDeAviso * 60;
    if (args.agoraEmSegundos < avisaEm) return false;
  }
  return true;
}

export type Acao = { avisar: boolean; fechar: boolean };

/**
 * O que fazer com a conversa. A nota sai uma vez por janela — quem garante é a
 * reserva no banco, chaveada pela mensagem do cliente —, e só no trecho
 * "fechando": depois de fechada, avisar que vai fechar não serve a ninguém.
 */
export function decidir(janela: Janela, etiquetas: readonly string[]): Acao {
  switch (janela.estado) {
    case "fechando":
      return { avisar: true, fechar: false };
    case "fechada":
      return { avisar: false, fechar: !temEtiquetaDeFechada(etiquetas) };
    case "aberta":
    case "indeterminada":
      return { avisar: false, fechar: false };
  }
}

/**
 * As etiquetas depois de fechar: tira a de aberta, põe a de fechada e mantém
 * TODAS as outras, na mesma ordem. O endpoint do Chatwoot substitui a lista
 * inteira; perder uma etiqueta alheia apagaria o critério de alguém.
 */
export function etiquetasDepoisDeFechar(etiquetas: readonly string[]): string[] {
  const resto = etiquetas.filter((e) => e !== ETIQUETA_ABERTA && e !== ETIQUETA_FECHADA);
  return [...resto, ETIQUETA_FECHADA];
}

const HORA = new Intl.DateTimeFormat("pt-BR", {
  timeZone: FUSO_SEAHUB,
  hour: "2-digit",
  minute: "2-digit",
});
const DIA = new Intl.DateTimeFormat("pt-BR", {
  timeZone: FUSO_SEAHUB,
  day: "2-digit",
  month: "2-digit",
});

/**
 * A nota para quem atende. A hora é a de São Paulo — o container roda em UTC, e
 * "fecha às 17:32" três horas errado mandaria alguém esperar uma janela que já
 * fechou.
 */
export function textoDaNota(fechaEm: number, instrucao: string): string {
  const instante = new Date(fechaEm * 1000);
  return (
    `${MARCA_DA_NOTA} fecha às ${HORA.format(instante)} de ${DIA.format(instante)}, ` +
    `${HORAS_DA_JANELA} h depois da última mensagem do cliente.\n${instrucao.trim()}`
  );
}
