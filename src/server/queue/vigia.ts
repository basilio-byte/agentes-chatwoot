import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ConversationStatus } from "@/generated/prisma/enums";
import { clienteDoAgente } from "@/server/integrations/chatwoot/credenciais";
import { resolverAtendente } from "@/server/integrations/chatwoot/atendentes";
import { entregarAoHumano } from "@/server/integrations/chatwoot/resolucao";
import { executarPrazosVencidos } from "@/server/prazos/executar";
import { executarPesquisasVencidas } from "@/server/nps/executar";
import { conferirSaldoEAvisar } from "@/server/alerta-de-saldo/alerta";
import { vereditoDaEscalada } from "./escalada";
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
 * que o cliente esperou além do tempo configurado. No mesmo relógio, executa os
 * prazos que os agentes registraram (`prazos/executar.ts`), as etapas vencidas
 * da pesquisa de satisfação (`nps/executar.ts`) e confere o saldo da OpenRouter
 * para o alerta por WhatsApp (`alerta-de-saldo/alerta.ts`).
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
      if (await escalar(conversa, minutos)) escaladas++;
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

/** `true` se escalou; `false` se a conversa ao vivo mostrou que não cabia. */
async function escalar(conversa: Parada, minutos: number): Promise<boolean> {
  // Sem a porta não há credencial para falar com o Chatwoot. Marca como humana
  // mesmo assim: o cliente ao menos deixa de esperar por um bot que não vem.
  const cliente = conversa.portaAgentId
    ? await clienteDoAgente(conversa.portaAgentId)
    : null;

  const conversaId = conversa.chatwootConversationId;

  if (cliente) {
    // ⚠ Confere o Chatwoot AO VIVO antes de falar. O banco pode estar atrasado
    // — o webhook de conta que registra "uma pessoa assumiu" pode não ter
    // chegado —, e escalar por cima de quem já está atendendo mandaria
    // "desculpe a demora" e tiraria a conversa dessa pessoa. Se a leitura
    // falhar, a exceção sobe e o vigia tenta de novo no minuto seguinte: na
    // dúvida, não fala.
    const veredito = vereditoDaEscalada(await cliente.obterConversa(conversaId));
    if (!veredito.escalar) {
      if (!veredito.resolvida && veredito.donoHumano) {
        await entregarAoHumano(
          conversaId,
          `vigia: ${veredito.motivo} — não escalou por cima`,
        );
      } else {
        // Resolvida ou adiada: ninguém espera o bot numa conversa em que ele não
        // pode agir. O corte de resolução segue com o webhook e o worker.
        await db.conversation.updateMany({
          where: { chatwootConversationId: conversaId },
          data: { aguardandoDesde: null },
        });
      }
      logger.info(
        { conversa: conversaId, motivo: veredito.motivo },
        "vigia não escalou: a conversa já tinha mudado no Chatwoot",
      );
      return false;
    }

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

  await entregarAoHumano(
    conversaId,
    `vigia: cliente esperou mais de ${minutos} min sem resposta`,
  );

  logger.warn(
    { conversa: conversaId, minutos },
    "conversa escalada por espera do cliente",
  );
  return true;
}

export function iniciarVigia(): NodeJS.Timeout {
  const rodar = async () => {
    // As tarefas são independentes de propósito: falha nos prazos não pode calar
    // a escalada que já existia, nem a pesquisa de satisfação, nem o contrário.
    try {
      const n = await vigiarEsperas();
      if (n > 0) logger.warn({ escaladas: n }, "vigia escalou conversas paradas");
    } catch (erro) {
      logger.error({ erro }, "vigia falhou");
    }

    try {
      const rodada = await executarPrazosVencidos();
      if (rodada.vistos > 0) logger.info(rodada, "prazos da conversa conferidos");
    } catch (erro) {
      logger.error({ erro }, "prazos da conversa falharam");
    }

    try {
      const rodada = await executarPesquisasVencidas();
      if (rodada.vistas > 0) logger.info(rodada, "pesquisas de satisfação conferidas");
    } catch (erro) {
      logger.error({ erro }, "pesquisas de satisfação falharam");
    }

    // Por último: é a única tarefa que fala com a OpenRouter e pode demorar, e
    // ela mesma segura o ritmo (confere a cada 10 min, não a cada minuto).
    try {
      await conferirSaldoEAvisar();
    } catch (erro) {
      logger.error({ erro }, "alerta de saldo falhou");
    }
  };

  void rodar();
  const timer = setInterval(rodar, INTERVALO_MS);
  timer.unref?.();
  return timer;
}
