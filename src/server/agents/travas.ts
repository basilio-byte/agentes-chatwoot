/**
 * Travas do laço de transferência.
 *
 * São quatro porque pegam coisas diferentes, e calibrar todas pelo mesmo número
 * foi o erro do primeiro desenho:
 *
 * - **Par repetido** pega o A↔B, a patologia real. É a mais apertada.
 * - **Visitas por agente** limita a cadeia sem número mágico: cresce sozinha
 *   quando a equipe cresce.
 * - **Prazo** é a única que mede o que o cliente sente. Ele não conta saltos,
 *   conta segundos de silêncio no WhatsApp.
 * - **Teto de saltos** é rede de segurança; com as outras três no lugar ele
 *   quase nunca morde.
 *
 * Encostar em qualquer uma é seguro: quem chama escala para um humano e avisa o
 * cliente. É por isso que dá para ser generoso — a referência que estudamos só
 * afrouxou os limites depois que o escalonamento ficou garantido.
 */

/**
 * Uma ida-e-volta legítima ("pergunta ao colega, recebe de volta") produz o par
 * duas vezes. Quatro permite duas rodadas dessas no mesmo turno, que acontece
 * quando um especialista precisa consultar o mesmo colega mais de uma vez.
 *
 * Precisa ser **menor ou igual** ao limite de visitas, senão a trava de visitas
 * dispara antes e o pinga-pong é diagnosticado como "agente acionado demais" —
 * a nota interna perderia justamente a informação que resolve o problema. Tem
 * teste travando essa ordem.
 */
export const LIMITE_POR_PAR = 4;

/**
 * Um agente concentrador (a recepção que distribui) é visitado várias vezes no
 * mesmo atendimento: entrada → reservas → entrada → documentos → entrada →
 * suporte. Cinco cobre esse padrão sem deixar um agente rodar sem fim.
 */
export const LIMITE_DE_VISITAS = 5;

/**
 * Rede de segurança para cadeia longa de agentes distintos — reservas,
 * documentos, serviços, suporte, especialista de recurso... Trinta é o valor
 * que a referência que estudamos usa em produção, e ele só é seguro porque
 * encostar aqui escala para um humano em vez de deixar a conversa morrer.
 */
export const MAX_SALTOS = 30;

/**
 * Último recurso contra turno travado (provedor pendurado), não orçamento de
 * experiência.
 *
 * Pode ser generoso porque **toda transferência avisa o cliente**: numa cadeia
 * longa ele não fica em silêncio, recebe uma mensagem a cada passagem. O que
 * esta trava evita é o turno que parou de progredir sem ninguém perceber.
 */
export const PRAZO_DO_TURNO_MS = 120_000;

export type MotivoDeParada =
  | "par_repetido"
  | "visitas_excedidas"
  | "prazo_esgotado"
  | "teto_de_saltos";

export type EstadoDoLaco = {
  /** Quantas vezes cada par não-ordenado já trocou a conversa neste turno. */
  pares: Map<string, number>;
  /** Quantas vezes cada agente já atendeu neste turno. */
  visitas: Map<string, number>;
  saltos: number;
  inicio: number;
};

export function novoEstado(inicio: number): EstadoDoLaco {
  return { pares: new Map(), visitas: new Map(), saltos: 0, inicio };
}

/** Par não-ordenado: A→B e B→A são a mesma dupla se transferindo. */
export function chaveDoPar(a: string, b: string): string {
  return [a, b].sort().join("::");
}

export function registrarVisita(estado: EstadoDoLaco, agenteId: string): void {
  estado.visitas.set(agenteId, (estado.visitas.get(agenteId) ?? 0) + 1);
}

/**
 * Decide se a transferência de `de` para `para` pode acontecer.
 *
 * Checa antes de saltar, não depois: deixar o salto acontecer e só então
 * perceber o laço gastaria mais uma chamada ao modelo por nada.
 */
export function podeTransferir(
  estado: EstadoDoLaco,
  de: string,
  para: string,
  agora: number,
): { pode: true } | { pode: false; motivo: MotivoDeParada } {
  if (agora - estado.inicio >= PRAZO_DO_TURNO_MS) {
    return { pode: false, motivo: "prazo_esgotado" };
  }

  if (estado.saltos + 1 > MAX_SALTOS) {
    return { pode: false, motivo: "teto_de_saltos" };
  }

  const par = chaveDoPar(de, para);
  if ((estado.pares.get(par) ?? 0) + 1 > LIMITE_POR_PAR) {
    return { pode: false, motivo: "par_repetido" };
  }

  if ((estado.visitas.get(para) ?? 0) + 1 > LIMITE_DE_VISITAS) {
    return { pode: false, motivo: "visitas_excedidas" };
  }

  return { pode: true };
}

/** Só depois de autorizado — mantém os contadores fiéis ao que aconteceu. */
export function registrarTransferencia(
  estado: EstadoDoLaco,
  de: string,
  para: string,
): void {
  const par = chaveDoPar(de, para);
  estado.pares.set(par, (estado.pares.get(par) ?? 0) + 1);
  estado.saltos++;
  registrarVisita(estado, para);
}

/** Texto para a nota interna — quem for resolver precisa saber o que travou. */
export function explicarParada(motivo: MotivoDeParada): string {
  switch (motivo) {
    case "par_repetido":
      return "dois agentes ficaram devolvendo a conversa um para o outro sem chegar a uma resposta";
    case "visitas_excedidas":
      return "o mesmo agente foi acionado vezes demais no mesmo atendimento";
    case "prazo_esgotado":
      return "o atendimento passou do tempo aceitável de espera do cliente";
    case "teto_de_saltos":
      return "o limite de transferências internas foi atingido";
  }
}
