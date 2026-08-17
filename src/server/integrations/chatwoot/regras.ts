/**
 * Regras globais de quando um agente pode agir numa conversa.
 *
 * Definidas em um lugar só, como funções puras, porque são a diferença entre o
 * bot ajudar e o bot atropelar um atendimento humano. São aplicadas em três
 * pontos: na chegada do webhook, no início do processamento e — o que torna a
 * regra absoluta — imediatamente antes de enviar a resposta, contra o estado ao
 * vivo do Chatwoot.
 */

/** Status em que o agente pode falar. Qualquer outro é silêncio. */
export const STATUS_PERMITIDOS = ["open", "pending"] as const;

export type EstadoDaConversa = {
  status?: string | null;
  /** Id do responsável pela conversa, se houver. */
  assigneeId?: number | null;
  /**
   * O responsável é uma **pessoa**?
   *
   * `undefined` = não se sabe, e aí vale a suposição segura: trate como pessoa e
   * cale. Falar por cima de um atendente de verdade é pior que ficar quieto, e a
   * incerteza sempre pende para o silêncio.
   *
   * `false` = o responsável não está na lista de agentes da conta. Na prática é
   * o **nosso próprio Agent Bot**, que o Chatwoot atribui sozinho em algumas
   * caixas. Sem esta distinção, o bot lia a si mesmo como "humano assumiu" e
   * calava para sempre — e a conversa resolvida nem reabria, porque reabrir
   * exige não ter dono. Silêncio permanente, sem erro nenhum.
   */
  donoEhHumano?: boolean;
};

/**
 * `donoNaoHumano` viaja nos dois lados do veredito de propósito: quem recebe
 * "não pode" por estar resolvida ainda precisa saber que o dono é o bot, para
 * poder reabrir e se desatribuir.
 */
export type Veredito =
  | { pode: true; donoNaoHumano?: boolean }
  | { pode: false; motivo: string; resolvida?: boolean; donoNaoHumano?: boolean };

/** O responsável existe e comprovadamente não é gente. */
export function donoNaoEhHumano(estado: EstadoDaConversa): boolean {
  return estado.assigneeId != null && estado.donoEhHumano === false;
}

export function podeAgir(estado: EstadoDaConversa): Veredito {
  const donoNaoHumano = donoNaoEhHumano(estado);

  // Regra 1: humano assumiu, o bot cala. Vale mesmo em conversa aberta.
  //
  // Dono que NÃO é gente não conta: é o próprio bot, e um bot não "assume"
  // conversa de ninguém — muito menos da gente.
  if (estado.assigneeId != null && !donoNaoHumano) {
    return { pode: false, motivo: "conversa atribuída a um humano" };
  }

  const status = estado.status?.toLowerCase();

  // Regra 2: conversa resolvida não recebe interação nenhuma.
  if (status === "resolved") {
    return { pode: false, motivo: "conversa resolvida", resolvida: true, donoNaoHumano };
  }

  if (status && !STATUS_PERMITIDOS.includes(status as "open" | "pending")) {
    return { pode: false, motivo: `conversa em status ${status}`, donoNaoHumano };
  }

  return { pode: true, donoNaoHumano };
}

export function ehResolvida(status?: string | null) {
  return status?.toLowerCase() === "resolved";
}

/**
 * Regra 4: conversa atendida pelo bot nunca fica **pendente**.
 *
 * O Chatwoot coloca em `pending` a conversa de uma caixa que tem Agent Bot, e
 * `pending` **não aparece na visualização padrão** — só por filtro. Uma
 * conversa que o bot está tocando ficaria invisível para a equipe, e ninguém
 * perceberia se ela precisasse de gente.
 *
 * O bot só age em `open` e `pending` (ver `podeAgir`), mas **termina sempre em
 * `open`**. Ele nunca resolve: encerrar atendimento é decisão de pessoa.
 */
export function precisaAbrir(status?: string | null): boolean {
  return (status ?? "").toLowerCase() === "pending";
}
