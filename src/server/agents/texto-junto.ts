import type { RunSource } from "@/generated/prisma/enums";
import { tipoDeTurno } from "./conduta";

/**
 * O texto que o modelo escreve JUNTO com um pedido de ferramenta não chega ao
 * cliente — e o modelo precisa ser avisado disso no momento em que acontece.
 *
 * Quem fala com o cliente é o worker, com o texto da ÚLTIMA mensagem do turno
 * (`resposta` no runner). O texto de uma mensagem que também pede ferramenta é
 * sobrescrito pelo da mensagem seguinte, e some.
 *
 * ⚠ Achado em 21/09/2026, no primeiro dia do proxy Claude MAX, na conversa
 * 13146: o agente de salas privativas escreveu a pergunta ao cliente ("E qual
 * a pretensão de mudança, tem uma data em mente?") na mesma mensagem em que
 * registrou o prazo de resposta do cliente. O retorno da ferramenta disse
 * "termine o seu turno normalmente", e ele fechou com um recado para si mesmo —
 * "Aguardando o cliente responder. Não vou enviar nova mensagem agora." Foi
 * ESSE o texto enviado, três vezes seguidas, e o cliente respondeu "Não
 * compreendi". Para o Claude, texto e ferramenta na mesma mensagem é o jeito
 * natural de falar e agir; ele não tinha como saber que a pergunta ficou para
 * trás.
 *
 * Não é defeito só do proxy: o GLM, na OpenRouter, também escreve texto junto
 * com ferramenta (5 dos 10 turnos com ferramenta daquela manhã). Lá não
 * aparecia porque quase sempre era antes de atribuir a uma pessoa, e aí nada
 * sai. Por isso vale para os dois motores.
 *
 * O aviso vai no retorno da ferramenta, e não numa mensagem `system`: é onde o
 * modelo lê o que acabou de acontecer, e o proxy junta toda mensagem `system`
 * no prompt de sistema, longe do ponto da conversa a que ela se refere. E só
 * aparece quando o caso acontece — não custa nada nos turnos em que o modelo
 * age sem escrever junto.
 */
export const AVISO_TEXTO_JUNTO =
  "[Aviso do sistema, não é retorno da ferramenta] O texto que você escreveu " +
  "junto com este pedido de ferramenta NÃO foi enviado ao cliente: só a sua " +
  "última mensagem do turno, escrita depois das ferramentas, chega até ele. " +
  "Se a sua resposta ao cliente ainda não saiu, escreva-a completa agora.";

type MensagemDeTool = { role: "tool"; tool_call_id: string; content: unknown };

/**
 * Acrescenta o aviso ao último retorno do lote, quando a mensagem que pediu as
 * ferramentas trazia texto e o turno é de conversa com cliente.
 *
 * Só em conversa (Chatwoot e playground, que existe para prever a produção):
 * nas outras origens o texto final não vai a cliente nenhum, e "chega até ele"
 * seria falso. O aviso vai no ÚLTIMO retorno por ser o mais perto da próxima
 * resposta; e o que fica gravado em `ToolCall` continua sendo o retorno da
 * ferramenta, sem o aviso — ele existe só na mensagem mandada ao modelo.
 */
export function avisarTextoJunto<T extends MensagemDeTool>(
  resultados: T[],
  textoJunto: string | null | undefined,
  source: RunSource,
): T[] {
  if (!textoJunto?.trim() || resultados.length === 0) return resultados;
  if (tipoDeTurno(source) !== "conversa") return resultados;

  const ultimo = resultados[resultados.length - 1];
  if (typeof ultimo.content !== "string") return resultados;

  return [
    ...resultados.slice(0, -1),
    { ...ultimo, content: `${ultimo.content}\n\n${AVISO_TEXTO_JUNTO}` },
  ];
}
