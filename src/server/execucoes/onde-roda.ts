import { RunSource } from "@/generated/prisma/enums";

/**
 * Em qual processo o turno de cada origem realmente roda.
 *
 * Serve a uma pergunta só, feita em `pararExecucao`: existe alguém vivo para
 * receber o pedido de parada? Quem roda no worker é julgado pelo batimento
 * dele; quem roda no processo do painel não pode ser julgado assim — o painel
 * é quem está atendendo o clique, então ele está vivo por definição.
 *
 * ⚠ **Isto é um mapa, e não uma comparação com `PLAYGROUND`, porque a
 * comparação não era cobrada por ferramenta nenhuma.** A condição isentava só
 * o playground; uma origem nova que rodasse no painel e não fosse acrescentada
 * ali passaria a ser julgada pelo batimento do WORKER. Com o worker fora do ar
 * — ou apenas reiniciando —, apertar "parar" em /execuções marcaria `CANCELED`
 * uma execução VIVA e respondendo, sem erro, sem rastro e sem um compilador
 * reclamando. Sendo `Record<RunSource, …>`, a sexta origem quebra o typecheck
 * aqui, que é exatamente a propriedade que faltava.
 */
export const ONDE_RODA: Record<RunSource, "painel" | "worker"> = {
  [RunSource.CHATWOOT]: "worker",
  [RunSource.TRIGGER]: "worker",
  [RunSource.SCHEDULE]: "worker",
  // O playground roda dentro da rota do painel, e a mesa do agente roda no
  // mesmo processo pela mesma razão: quem dispara as duas é a página logada,
  // não a fila.
  [RunSource.PLAYGROUND]: "painel",
  [RunSource.MESA]: "painel",
  // A chamada interna roda dentro do turno de quem acionou: no worker quando
  // veio do atendimento, no painel quando veio do playground ou da mesa. Sem
  // saber qual, fica do lado que nunca encerra um turno vivo — julgada só pela
  // idade. O preço é o zumbi de um worker morto esperar essa idade para fechar.
  [RunSource.INTERNO]: "painel",
  // Sai da fila do gatilho de conversa, como o agendamento.
  [RunSource.CONVERSA_ENCERRADA]: "worker",
  // Sai da fila do gatilho de checkbox, pelo mesmo caminho.
  [RunSource.CONVERSA_MARCADA]: "worker",
};
