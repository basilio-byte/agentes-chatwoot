/**
 * A `mensagem` que `executarAgente` recebe quando o turno vem do relógio.
 *
 * Diferente do gatilho HTTP, aqui não existe payload: quem escreve o que fazer
 * é o operador, na tela. O preâmbulo existe para o modelo não confundir isto
 * com uma pergunta de cliente — não há ninguém esperando resposta em texto, e
 * o que ele escrever de volta não chega a lugar nenhum.
 *
 * ⚠ Data e hora **não** entram aqui. O runner já injeta o contexto temporal
 * como mensagem `system` imediatamente antes desta, no fuso de São Paulo.
 * Repetir criaria duas fontes para a mesma informação, e elas divergiriam.
 */
export function montarMensagemDoAgendamento(args: {
  nome: string;
  instrucao: string;
}): string {
  return [
    `[Execução agendada — "${args.nome}". Disparada pelo relógio, fora de qualquer conversa.`,
    "Não há cliente esperando: o que você escrever como resposta não vai para ninguém.",
    "O que produz efeito aqui são as ferramentas que você tem ligadas.]",
    "",
    args.instrucao.trim(),
  ].join("\n");
}
