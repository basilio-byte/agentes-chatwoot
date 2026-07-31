import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ConversationStatus } from "@/generated/prisma/enums";
import { clienteDoAgente } from "@/server/integrations/chatwoot/credenciais";
import { resolverAtendente } from "@/server/integrations/chatwoot/atendentes";
import { esperouDemais, minutosDeEspera } from "./espera";

/**
 * Vigia das conversas paradas.
 *
 * Existe porque nem toda falha grita. O laço do agente tem rede de segurança
 * para o que ele consegue ver — exceção, resposta vazia, laço de transferência.
 * Mas modelo pendurado, worker morto no meio do turno ou job perdido não
 * produzem erro nenhum: só silêncio, e o cliente esperando sem saber.
 *
 * Roda de minuto em minuto no worker e entrega a uma pessoa toda conversa em
 * que o cliente esperou além do tempo configurado.
 */
const INTERVALO_MS = 60_000;

export async function vigiarEsperas(agora = Date.now()): Promise<number> {
  const paradas = await db.conversation.findMany({
    where: {
      status: ConversationStatus.BOT,
      aguardandoDesde: { not: null },
    },
    select: {
      id: true,
      chatwootConversationId: true,
      aguardandoDesde: true,
      status: true,
      portaAgentId: true,
      ultimaFalha: true,
      agent: { select: { name: true, fallbackMinutos: true, fallbackAtendente: true } },
    },
  });

  let escaladas = 0;

  for (const conversa of paradas) {
    const minutos = minutosDeEspera(conversa.agent?.fallbackMinutos);
    if (!esperouDemais(conversa, minutos, agora)) continue;

    try {
      await escalar(conversa, minutos);
      escaladas++;
    } catch (erro) {
      // Uma conversa que não deu para escalar não pode impedir as outras.
      logger.error(
        { conversa: conversa.chatwootConversationId, erro },
        "vigia não conseguiu escalar",
      );
    }
  }

  return escaladas;
}

type Parada = {
  id: string;
  chatwootConversationId: number;
  portaAgentId: string | null;
  ultimaFalha: string | null;
  agent: { name: string; fallbackAtendente: string | null } | null;
};

async function escalar(conversa: Parada, minutos: number) {
  // Sem a porta não há credencial para falar com o Chatwoot. Marca como humana
  // mesmo assim: o cliente ao menos deixa de esperar por um bot que não vem.
  const cliente = conversa.portaAgentId
    ? await clienteDoAgente(conversa.portaAgentId)
    : null;

  const conversaId = conversa.chatwootConversationId;

  if (cliente) {
    const nota = [
      `⚠️ O cliente está esperando há mais de ${minutos} minuto(s) e o agente` +
        ` "${conversa.agent?.name ?? "?"}" não respondeu.`,
      conversa.ultimaFalha
        ? `Última falha registrada: ${conversa.ultimaFalha}`
        : "Nenhum erro foi registrado — provável travamento do modelo ou do processamento.",
      "Alguém precisa assumir daqui.",
    ].join("\n");

    await cliente.enviarMensagem(conversaId, nota, { privado: true });

    // Antes de atribuir: preencher assignee_id faz a regra global calar o bot,
    // e a mensagem ao cliente seria descartada.
    await cliente.enviarMensagem(
      conversaId,
      "Desculpe a demora! Já estou chamando alguém da equipe para continuar seu atendimento 😊",
    );

    await cliente.alternarStatus(conversaId, "open");

    const alvo = conversa.agent?.fallbackAtendente;
    if (alvo) {
      const achado = resolverAtendente(alvo, await cliente.listarAtendentes());
      if (achado.tipo === "achado") {
        await cliente.atribuir(conversaId, { assigneeId: achado.atendente.id });
      } else {
        logger.warn(
          { conversa: conversaId, alvo },
          "atendente de fallback não existe no Chatwoot — conversa fica na fila",
        );
      }
    }
  }

  await db.conversation.update({
    where: { id: conversa.id },
    data: {
      status: ConversationStatus.HUMAN,
      aguardandoDesde: null,
      handoffReason: `vigia: cliente esperou mais de ${minutos} min sem resposta`,
      handoffAt: new Date(),
    },
  });

  logger.warn(
    { conversa: conversaId, minutos },
    "conversa escalada por espera do cliente",
  );
}

export function iniciarVigia(): NodeJS.Timeout {
  const rodar = async () => {
    try {
      const n = await vigiarEsperas();
      if (n > 0) logger.warn({ escaladas: n }, "vigia escalou conversas paradas");
    } catch (erro) {
      logger.error({ erro }, "vigia falhou");
    }
  };

  void rodar();
  const timer = setInterval(rodar, INTERVALO_MS);
  timer.unref?.();
  return timer;
}
