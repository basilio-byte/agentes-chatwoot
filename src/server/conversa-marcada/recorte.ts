import {
  ehAtividadeDeResolucao,
  recortarAtendimento,
  type MensagemDoCiclo,
  type Recorte,
} from "@/server/conversa-encerrada/ciclo";

/**
 * O atendimento sobre o qual a equipe marcou o checkbox.
 *
 * Na conversa aberta — o caso comum —, é o que veio depois da última resolução
 * até a marcação: o mesmo recorte da conversa encerrada, com o instante da
 * marcação no lugar do da resolução.
 *
 * ⚠ Na conversa JÁ resolvida esse recorte sai vazio: depois da resolução só há
 * a atividade do próprio checkbox. Aí o atendimento é o que terminou naquela
 * resolução — quem marca depois de encerrar está falando dele, e não de um
 * atendimento que nem começou.
 */
export function recortarAtendimentoAtual(
  mensagens: MensagemDoCiclo[],
  marcadoEm: number,
): Recorte {
  const recorte = recortarAtendimento(mensagens, marcadoEm);
  if (recorte.mensagens.some((m) => m.message_type !== 2)) return recorte;

  const ultimaResolucao = [...mensagens]
    .sort((a, b) => a.id - b.id)
    .filter(
      (m) =>
        ehAtividadeDeResolucao(m) &&
        typeof m.created_at === "number" &&
        m.created_at <= marcadoEm,
    )
    .at(-1);

  if (typeof ultimaResolucao?.created_at !== "number") return recorte;
  return recortarAtendimento(mensagens, ultimaResolucao.created_at);
}
