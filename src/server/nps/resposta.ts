import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { IntegrationProvider, PesquisaNpsStatus } from "@/generated/prisma/enums";
import { agendarPesquisaNps } from "@/server/queue/nps";
import { juntarRastro, lerNota, mensagemDoCliente } from "./regras";

export type Captura = { capturada: false } | { capturada: true; detalhe: string };

const ESPERANDO_NOTA: PesquisaNpsStatus[] = [
  PesquisaNpsStatus.AGUARDANDO,
  PesquisaNpsStatus.LEMBRADA,
];
const DEPOIS_DA_NOTA: PesquisaNpsStatus[] = [
  PesquisaNpsStatus.RESPONDIDA,
  PesquisaNpsStatus.AGRADECIDA,
];

/**
 * A mensagem do cliente pertence à pesquisa de satisfação?
 *
 * A rota do bot chama isto ANTES de decidir se o agente responde, que calaria a
 * nota numa conversa atribuída, e antes do relógio da espera. Mensagem capturada
 * não vira atendimento. Nunca lança: na falha, o atendimento segue como se não
 * houvesse pesquisa.
 *
 * - Pesquisa esperando a nota, e a mensagem É a nota: registra e adianta o relógio.
 * - Pesquisa esperando a nota, e a mensagem é outra coisa: a pesquisa acaba ali,
 *   sem lembrete e sem resolver, e o agente atende. Uma nota que chegasse depois
 *   seria lida no meio de outra conversa — "2" pode ser a opção de um menu.
 * - Nota já recebida: é complemento. Pedido do usuário (15/09/2026): quem
 *   responde "o que aconteceu?" precisa de tempo para contar. Fica na conversa,
 *   empurra o encerramento e não aciona o agente.
 */
export async function capturarRespostaDoNps(
  payload: unknown,
  portaAgentId: string,
  agora = Date.now(),
): Promise<Captura> {
  const mensagem = mensagemDoCliente(payload);
  if (!mensagem) return { capturada: false };

  try {
    // Duas voltas: o lembrete pode trocar o status entre a leitura e a gravação.
    for (let volta = 0; volta < 2; volta++) {
      const pesquisa = await db.pesquisaNps.findFirst({
        where: {
          chatwootConversationId: mensagem.conversationId,
          status: { in: [...ESPERANDO_NOTA, ...DEPOIS_DA_NOTA] },
        },
        select: { id: true, status: true, portaAgentId: true, resultado: true },
      });
      if (!pesquisa) return { capturada: false };

      // Desligar é o botão de parada: a mensagem volta a ser do atendimento.
      const integracao = await db.integration.findUnique({
        where: { provider: IntegrationProvider.NPS },
        select: { enabled: true },
      });
      if (!integracao?.enabled) return { capturada: false };

      if (DEPOIS_DA_NOTA.includes(pesquisa.status)) {
        const { count } = await db.pesquisaNps.updateMany({
          where: { id: pesquisa.id, status: { in: DEPOIS_DA_NOTA } },
          data: { ultimaMensagemEm: new Date(agora) },
        });
        if (count === 1) {
          return {
            capturada: true,
            detalhe: "complemento à pesquisa de satisfação — o agente não foi acionado",
          };
        }
        continue;
      }

      const nota = lerNota(mensagem.texto);

      if (nota === null) {
        const { count } = await db.pesquisaNps.updateMany({
          where: { id: pesquisa.id, status: pesquisa.status },
          data: {
            status: PesquisaNpsStatus.CANCELADA,
            finalizadaEm: new Date(agora),
            resultado: juntarRastro([
              pesquisa.resultado,
              "o cliente escreveu outra coisa em vez da nota — sem lembrete e sem resolver",
            ]),
          },
        });
        if (count === 1) return { capturada: false };
        continue;
      }

      const { count } = await db.pesquisaNps.updateMany({
        where: { id: pesquisa.id, status: pesquisa.status },
        data: {
          status: PesquisaNpsStatus.RESPONDIDA,
          nota,
          notaMensagemId: mensagem.mensagemId,
          respondidaEm: new Date(agora),
          ultimaMensagemEm: new Date(agora),
          venceEm: new Date(agora),
          portaAgentId: pesquisa.portaAgentId ?? portaAgentId,
          tentativas: 0,
        },
      });
      if (count !== 1) continue;

      try {
        await agendarPesquisaNps(pesquisa.id);
      } catch (erro) {
        logger.warn(
          { erro, pesquisaId: pesquisa.id },
          "NPS: não consegui enfileirar a resposta à nota — fica com o vigia",
        );
      }
      return { capturada: true, detalhe: `nota ${nota} da pesquisa de satisfação` };
    }

    return { capturada: false };
  } catch (erro) {
    logger.error(
      { erro, conversa: mensagem.conversationId },
      "NPS: não consegui conferir a resposta — segue como atendimento",
    );
    return { capturada: false };
  }
}
