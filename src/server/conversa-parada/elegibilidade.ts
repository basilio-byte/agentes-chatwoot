import type { MensagemDoCiclo } from "@/server/conversa-encerrada/ciclo";
import { humanidadeDoDono } from "@/server/integrations/chatwoot/regras";

/**
 * Quais conversas o assistente comercial analisa, e quais ele deixa em paz.
 *
 * Puro e testado porque é aqui que se decide gastar dinheiro com o modelo, e
 * porque cada linha deste arquivo corrige um defeito medido no fluxo do n8n que
 * este módulo substitui (`Comercial - Assistente Vendedor`, despublicado em
 * 17/09/2026).
 */

/** O que a listagem de conversas dá de graça, antes de ler mensagem nenhuma. */
export type ConversaDaVarredura = {
  id: number;
  inboxId?: number | null;
  status: string | null;
  assigneeId: number | null;
  assigneeTipo: string | null;
  assigneeNome?: string | null;
  contatoNome?: string | null;
  telefone?: string | null;
  ultimaMensagem: { id: number; criadaEm: number | null; privada: boolean } | null;
};

export type Recusa = { entra: false; motivo: string };
export type Aceite = { entra: true };

/**
 * Primeiro filtro, feito só com a listagem — sem uma chamada HTTP por conversa.
 *
 * Deixa passar tudo o que possa ser elegível: quem decide de verdade é
 * `vereditoDaConversa`, depois de ler as mensagens. O único caso descartado
 * aqui é o barato e certo: conversa cuja última mensagem PÚBLICA é recente.
 *
 * ⚠ Mensagem privada não descarta nada, e é a linha mais importante do arquivo.
 * A nota interna que este agente escreve vira a última mensagem não-atividade
 * da conversa: se ela contasse, a conversa comentada hoje pareceria ativa
 * amanhã, e a que ninguém respondeu há uma semana sumiria do radar no dia
 * seguinte ao primeiro comentário — o filtro esconderia exatamente o que ele
 * existe para achar.
 */
export function passaNoPreFiltro(
  conversa: ConversaDaVarredura,
  horasParadas: number,
  agoraEmSegundos: number,
): boolean {
  const ultima = conversa.ultimaMensagem;
  if (!ultima || ultima.privada || ultima.criadaEm == null) return true;
  return agoraEmSegundos - ultima.criadaEm >= horasParadas * 3600;
}

/**
 * O veredito final, já com as mensagens do atendimento na mão.
 *
 * A ordem das recusas é a do custo: o que dá para saber sem o modelo vem
 * primeiro, e o motivo de cada uma vai para o resumo da rodada — silêncio
 * precisa deixar rastro.
 */
export function vereditoDaConversa(args: {
  conversa: ConversaDaVarredura;
  mensagens: MensagemDoCiclo[];
  horasParadas: number;
  agoraEmSegundos: number;
  /** Nomes de contas do Chatwoot que escrevem como gente sem ser gente. */
  contasDeAutomacao: readonly string[];
}): Aceite | Recusa {
  const { conversa, horasParadas, agoraEmSegundos } = args;

  if (conversa.status !== "open") {
    return { entra: false, motivo: "a conversa não está aberta" };
  }

  // ⚠ Aqui a regra é o INVERSO da de todo o resto do sistema: esta origem só
  // existe para conversa que tem gente atendendo. Sem dono, ou com o nosso
  // robô como dono, não há para quem escrever a nota — e o vigia e o
  // atendimento já cuidam desse caso.
  if (conversa.assigneeId == null || humanidadeDoDono(conversa.assigneeTipo) !== true) {
    return { entra: false, motivo: "não há uma pessoa responsável pela conversa" };
  }

  const ultima = ultimaMensagemPublica(args.mensagens);
  if (!ultima) {
    return { entra: false, motivo: "nenhuma mensagem pública para analisar" };
  }

  if (typeof ultima.created_at !== "number") {
    // Sem data não dá para dizer que está parada, e a dúvida não gasta modelo.
    return { entra: false, motivo: "a última mensagem não tem data" };
  }

  const horas = (agoraEmSegundos - ultima.created_at) / 3600;
  if (horas < horasParadas) {
    return {
      entra: false,
      motivo: `parada há ${horas.toFixed(1)}h, menos que as ${horasParadas}h configuradas`,
    };
  }

  if (!temConversaDeVerdade(args.mensagens, args.contasDeAutomacao)) {
    return { entra: false, motivo: "não houve conversa: só robô, saudação ou atividade" };
  }

  return { entra: true };
}

/**
 * A última mensagem que o cliente ou a equipe mandou para o outro lado.
 *
 * Exclui atividade (`2`), template (`3`) e **nota privada**. É este instante
 * que responde "há quanto tempo ninguém fala com essa pessoa" — a pergunta que
 * o gatilho faz.
 */
export function ultimaMensagemPublica(
  mensagens: readonly MensagemDoCiclo[],
): MensagemDoCiclo | null {
  const publicas = mensagens.filter(
    (m) => (m.message_type === 0 || m.message_type === 1) && m.private !== true,
  );
  if (publicas.length === 0) return null;
  return publicas.reduce((maior, m) => (m.id > maior.id ? m : maior));
}

/**
 * Houve troca de verdade nesta conversa?
 *
 * Exige ao menos uma mensagem do CLIENTE com conteúdo além de uma saudação. É o
 * que separa o atendimento que dá material para analisar do contato que só
 * disse "oi" e recebeu o menu do robô — no lote de 17/09 o fluxo do n8n gastou
 * uma análise inteira num desses, para concluir que o lead "travou na pergunta
 * do bot".
 */
export function temConversaDeVerdade(
  mensagens: readonly MensagemDoCiclo[],
  contasDeAutomacao: readonly string[],
): boolean {
  const doCliente = mensagens.filter(
    (m) => m.message_type === 0 && m.private !== true && (m.content ?? "").trim().length > 0,
  );
  if (doCliente.length === 0) return false;

  const substancia = doCliente.some(
    (m) => (m.content ?? "").trim().length > TAMANHO_DE_SAUDACAO,
  );
  if (!substancia) return false;

  // Alguém — cliente ou equipe — precisa ter escrito depois do robô. Conversa
  // em que só o bot falou não tem vendedor a orientar.
  return mensagens.some((m) => {
    if (m.private === true) return false;
    if (m.message_type !== 1) return false;
    const tipo = m.sender?.type?.toLowerCase();
    if (tipo !== "user") return false;
    return !ehAutomacao(m.sender?.name, contasDeAutomacao);
  });
}

/** Acima disto, o cliente escreveu algo além de "oi", "bom dia" ou "tudo bem?". */
export const TAMANHO_DE_SAUDACAO = 15;

/**
 * Conta do Chatwoot que escreve com nome de gente mas é fluxo.
 *
 * Mesma comparação do ciclo da conversa encerrada: sem acento, sem caixa e sem
 * espaço — a lista é escrita à mão na tela e ninguém acerta o acento de
 * memória.
 */
function ehAutomacao(nome: string | null | undefined, contas: readonly string[]): boolean {
  if (!nome) return false;
  const alvo = normalizar(nome);
  return contas.some((conta) => normalizar(conta) === alvo);
}

function normalizar(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}
