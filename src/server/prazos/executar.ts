import { z } from "zod";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { IntegrationProvider, PrazoStatus } from "@/generated/prisma/enums";
import type { ChatwootClient } from "@/server/integrations/chatwoot/client";
import { clienteDoAgente } from "@/server/integrations/chatwoot/credenciais";
import { resolverAtendente } from "@/server/integrations/chatwoot/atendentes";
import { humanidadeDoDono } from "@/server/integrations/chatwoot/regras";
import {
  devolverAoAgente,
  entregarAoHumano,
} from "@/server/integrations/chatwoot/resolucao";
import { agendarAtendimento } from "@/server/queue/atendimento";
import { passarTarefaDoCrm, type AtualizacaoDoCrm } from "./crm";
import { decidirPrazo, type AcaoDoPrazo } from "./decisao";

/**
 * Executa os prazos vencidos — chamado pelo vigia a cada minuto.
 *
 * A ordem de cada prazo é sempre a mesma, e é ela que sustenta a garantia de não
 * se meter em atendimento de pessoa: trava o prazo, confere o Chatwoot AO VIVO
 * (conversa, dono e mensagens), decide pela função pura e só então age — a
 * leitura e a escrita coladas, para a janela em que alguém poderia agir no meio
 * ficar em milissegundos.
 */

const POR_RODADA = 50;

/**
 * Espera antes do turno de retomada: o bastante para a nota interna da volta
 * chegar ao Chatwoot antes da primeira fala do agente.
 */
const ESPERA_DA_RETOMADA_S = 2;

const acaoSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("reatribuir"), atendente: z.string().min(1) }),
  z.object({ tipo: z.literal("voltar_para_o_agente") }),
  z.object({ tipo: z.literal("mensagem"), texto: z.string().min(1) }),
  z.object({
    tipo: z.literal("atribuir"),
    atendente: z.string().min(1),
    aviso: z.string().min(1),
  }),
]);

type Prazo = NonNullable<Awaited<ReturnType<typeof db.prazoDeConversa.findFirst>>>;
type Fim = { status: PrazoStatus; resultado: string | null };

export type RodadaDePrazos = {
  vistos: number;
  executados: number;
  cancelados: number;
  descartados: number;
  falhas: number;
};

export async function executarPrazosVencidos(agora = Date.now()): Promise<RodadaDePrazos> {
  const rodada: RodadaDePrazos = {
    vistos: 0,
    executados: 0,
    cancelados: 0,
    descartados: 0,
    falhas: 0,
  };

  const vencidos = await db.prazoDeConversa.findMany({
    where: { status: PrazoStatus.PENDENTE, venceEm: { lte: new Date(agora) } },
    orderBy: { venceEm: "asc" },
    take: POR_RODADA,
  });
  if (vencidos.length === 0) return rodada;
  rodada.vistos = vencidos.length;

  const integracao = await db.integration.findUnique({
    where: { provider: IntegrationProvider.PRAZOS },
    select: { id: true, enabled: true },
  });

  for (const prazo of vencidos) {
    // Trava: duas voltas do relógio, ou duas réplicas, nunca agem no mesmo prazo.
    const pego = await db.prazoDeConversa.updateMany({
      where: { id: prazo.id, status: PrazoStatus.PENDENTE },
      data: { status: PrazoStatus.EXECUTANDO },
    });
    if (pego.count !== 1) continue;

    let fim: Fim;
    try {
      fim = await tratar(prazo, agora, integracao);
    } catch (erro) {
      logger.error(
        { prazo: prazo.id, conversa: prazo.chatwootConversationId, erro },
        "prazo da conversa falhou",
      );
      fim = {
        status: PrazoStatus.FALHOU,
        resultado: erro instanceof Error ? erro.message : String(erro),
      };
    }

    await db.prazoDeConversa.update({
      where: { id: prazo.id },
      data: {
        status: fim.status,
        resultado: fim.resultado?.slice(0, 2000) ?? null,
        finalizadoEm: fim.status === PrazoStatus.PENDENTE ? null : new Date(),
      },
    });

    if (fim.status === PrazoStatus.EXECUTADO) rodada.executados++;
    else if (fim.status === PrazoStatus.CANCELADO) rodada.cancelados++;
    else if (fim.status === PrazoStatus.DESCARTADO) rodada.descartados++;
    else if (fim.status === PrazoStatus.FALHOU) rodada.falhas++;

    logger.info(
      {
        prazo: prazo.id,
        conversa: prazo.chatwootConversationId,
        tipo: prazo.tipo,
        status: fim.status,
        resultado: fim.resultado,
      },
      "prazo da conversa tratado",
    );
  }

  return rodada;
}

async function tratar(
  prazo: Prazo,
  agora: number,
  integracao: { id: string; enabled: boolean } | null,
): Promise<Fim> {
  // Desligar a integração é o botão de parada: prazo pendente não age mais.
  if (!integracao?.enabled) {
    return { status: PrazoStatus.DESCARTADO, resultado: "integração de prazos desligada" };
  }
  const ligadaNoAgente = await db.agentIntegration.findFirst({
    where: { agentId: prazo.agentId, integrationId: integracao.id, enabled: true },
    select: { id: true },
  });
  if (!ligadaNoAgente) {
    return {
      status: PrazoStatus.DESCARTADO,
      resultado: "integração de prazos desligada para o agente",
    };
  }

  const acao = acaoSchema.safeParse(prazo.acao);
  if (!acao.success) {
    return { status: PrazoStatus.FALHOU, resultado: "ação do prazo em formato inesperado" };
  }

  const cliente = await clienteDoAgente(prazo.portaAgentId);
  if (!cliente) {
    return {
      status: PrazoStatus.DESCARTADO,
      resultado: "sem credencial do Chatwoot para a porta desta conversa",
    };
  }

  const conversaId = prazo.chatwootConversationId;
  const [aoVivo, mensagens, conversaNoBanco] = await Promise.all([
    cliente.obterConversa(conversaId),
    cliente.listarMensagens(conversaId),
    db.conversation.findUnique({
      where: { chatwootConversationId: conversaId },
      select: { agentId: true, chatwootInboxId: true },
    }),
  ]);

  const decisao = decidirPrazo({
    prazo: {
      tipo: prazo.tipo,
      minutos: prazo.minutos,
      venceEm: prazo.venceEm,
      referenciaMensagemId: prazo.referenciaMensagemId,
      donoId: prazo.donoId,
      agentId: prazo.agentId,
    },
    agora,
    conversa: aoVivo,
    agentIdDaConversa: conversaNoBanco?.agentId ?? null,
    mensagens,
  });

  switch (decisao.acao) {
    case "aguardar":
      return { status: PrazoStatus.PENDENTE, resultado: null };
    case "cancelar":
      return { status: PrazoStatus.CANCELADO, resultado: decisao.motivo };
    case "descartar":
      return { status: PrazoStatus.DESCARTADO, resultado: decisao.motivo };
    case "executar":
      return agir(cliente, prazo, acao.data, {
        inboxId: aoVivo.inboxId ?? conversaNoBanco?.chatwootInboxId ?? null,
      });
  }
}

/** O que dizer na nota sobre o CRM. Silêncio quando não havia task nenhuma. */
function linhasDoCrm(crm: AtualizacaoDoCrm): string[] {
  const linhas: string[] = [];
  for (const t of crm.tarefas) {
    linhas.push(
      `CRM: task ${t.url ?? t.id} passada para quem assumiu` +
        (t.vendedor
          ? `, VENDEDOR = ${t.vendedor}.`
          : ", mas o campo VENDEDOR ficou como estava."),
    );
  }
  for (const problema of crm.problemas) linhas.push(`AVISO: ${problema}`);
  return linhas;
}

const resumoDoCrm = (crm: AtualizacaoDoCrm) =>
  crm.tarefas.length
    ? ` · ${crm.tarefas.length} task(s) do CRM atualizada(s)`
    : crm.problemas.length
      ? " · CRM não atualizado"
      : "";

async function agir(
  cliente: ChatwootClient,
  prazo: Prazo,
  acao: AcaoDoPrazo,
  conversa: { inboxId: number | null },
): Promise<Fim> {
  const conversaId = prazo.chatwootConversationId;

  switch (acao.tipo) {
    case "reatribuir": {
      const achado = resolverAtendente(acao.atendente, await cliente.listarAtendentes());
      const antes = prazo.donoNome ?? "a pessoa atribuída";

      if (achado.tipo !== "achado") {
        await notaInterna(
          cliente,
          conversaId,
          `⏱️ Ninguém da equipe respondeu em ${prazo.minutos} min desde a atribuição a ${antes}, mas não achei "${acao.atendente}" na equipe do Chatwoot — a conversa continua com ${antes}.`,
        );
        return {
          status: PrazoStatus.FALHOU,
          resultado: `"${acao.atendente}" não encontrado na equipe`,
        };
      }

      const nome = achado.atendente.name?.trim() || acao.atendente;
      await cliente.atribuir(conversaId, { assigneeId: achado.atendente.id });

      // A task do CRM acompanha a troca: é por ela que se mede quem vendeu, e
      // ela ficava no nome de quem perdeu o prazo. Vai DEPOIS da atribuição no
      // Chatwoot, que é o que o cliente sente, e nunca lança.
      const crm = await passarTarefaDoCrm({
        chatwootConversationId: conversaId,
        de: prazo.donoNome,
        para: nome,
      });
      await notaInterna(
        cliente,
        conversaId,
        [
          `⏱️ Ninguém da equipe respondeu em ${prazo.minutos} min desde a atribuição a ${antes}. Conversa reatribuída para ${nome}.`,
          `Motivo registrado pelo agente: ${prazo.motivo}`,
          ...linhasDoCrm(crm),
        ].join("\n"),
      );
      await entregarAoHumano(conversaId, `prazo vencido: reatribuída a ${nome}`);
      return {
        status: PrazoStatus.EXECUTADO,
        resultado: `reatribuída a ${nome}${resumoDoCrm(crm)}`,
      };
    }

    case "voltar_para_o_agente": {
      const antes = prazo.donoNome ?? "a pessoa atribuída";
      const agente = await db.agent.findUnique({
        where: { id: prazo.agentId },
        select: { name: true, active: true, archivedAt: true },
      });

      // Agente desligado é o operador suspendendo o serviço: a conversa fica
      // com quem está, e a nota diz por que ninguém a tirou de lá.
      if (!agente?.active || agente.archivedAt) {
        await notaInterna(
          cliente,
          conversaId,
          `⏱️ Ninguém da equipe respondeu em ${prazo.minutos} min desde a atribuição a ${antes}, mas o agente que ia retomar o atendimento está desligado — a conversa continua com ${antes}.`,
        );
        return {
          status: PrazoStatus.FALHOU,
          resultado: "agente desligado ou arquivado — conversa não devolvida",
        };
      }
      if (conversa.inboxId == null) {
        return {
          status: PrazoStatus.FALHOU,
          resultado: "caixa de entrada da conversa desconhecida — conversa não devolvida",
        };
      }

      // Banco ANTES do Chatwoot. Se tirar a pessoa falhar depois disto, o
      // worker e o vigia conferem ao vivo, veem gente como dona e devolvem a
      // conversa a ela. Na ordem inversa, uma falha no banco deixaria a
      // conversa sem dono no Chatwoot e presa como humana aqui — ninguém
      // atenderia e ninguém vigiaria.
      const mudou = await devolverAoAgente(conversaId, {
        agentId: prazo.agentId,
        deNome: prazo.donoNome,
        motivo: prazo.motivo,
      });
      if (mudou === 0) {
        return {
          status: PrazoStatus.FALHOU,
          resultado: "conversa não existe no banco — não devolvida",
        };
      }

      await cliente.desatribuir(conversaId);

      // Tirar a pessoa pode não bastar: atribuição automática da caixa, ou
      // alguém assumindo no mesmo segundo. Com gente dona da conversa, ela é
      // dessa pessoa — o agente não retoma por cima.
      const depois = await cliente.obterConversa(conversaId);
      if (depois.assigneeId != null && humanidadeDoDono(depois.assigneeTipo) !== false) {
        await entregarAoHumano(
          conversaId,
          "prazo vencido, mas a conversa ficou com uma pessoa ao ser devolvida",
        );
        await notaInterna(
          cliente,
          conversaId,
          `⏱️ Ninguém da equipe respondeu em ${prazo.minutos} min desde a atribuição a ${antes}. Tentei devolver a conversa ao agente ${agente.name}, mas ela ficou com uma pessoa — o agente não retomou.`,
        );
        return {
          status: PrazoStatus.CANCELADO,
          resultado: "ao devolver, a conversa ficou com uma pessoa",
        };
      }

      // O turno antes da nota: se enfileirar falhar, o prazo termina como
      // falha sem uma nota dizendo que o agente retomou. O vigia ainda enxerga
      // a conversa, que ficou do bot com o cliente esperando.
      await agendarAtendimento(
        {
          chatwootConversationId: conversaId,
          agentId: prazo.portaAgentId,
          inboxId: conversa.inboxId,
        },
        ESPERA_DA_RETOMADA_S,
      );
      await notaInterna(
        cliente,
        conversaId,
        [
          `⏱️ Ninguém da equipe respondeu em ${prazo.minutos} min desde a atribuição a ${antes}. A conversa voltou para o agente ${agente.name}, que segue o atendimento sozinho.`,
          `Motivo registrado pelo agente: ${prazo.motivo}`,
        ].join("\n"),
      );
      return {
        status: PrazoStatus.EXECUTADO,
        resultado: `devolvida ao agente ${agente.name}`,
      };
    }

    case "mensagem": {
      await cliente.enviarMensagem(conversaId, acao.texto.trim());
      await notaInterna(
        cliente,
        conversaId,
        `⏱️ Cliente sem responder há ${prazo.minutos} min: mensagem de retomada enviada. Motivo: ${prazo.motivo}`,
      );
      return { status: PrazoStatus.EXECUTADO, resultado: "mensagem de retomada enviada" };
    }

    case "atribuir": {
      const achado = resolverAtendente(acao.atendente, await cliente.listarAtendentes());
      if (achado.tipo !== "achado") {
        await notaInterna(
          cliente,
          conversaId,
          `⏱️ Cliente sem responder há ${prazo.minutos} min, mas não achei "${acao.atendente}" na equipe do Chatwoot — ninguém foi atribuído.`,
        );
        return {
          status: PrazoStatus.FALHOU,
          resultado: `"${acao.atendente}" não encontrado na equipe`,
        };
      }

      const nome = achado.atendente.name?.trim() || acao.atendente;
      // Mesma ordem de `atribuir_para_atendente`: nota, aviso, abrir, atribuir.
      // O aviso sai ANTES de atribuir — com dono, a regra global cala o bot.
      await notaInterna(
        cliente,
        conversaId,
        [
          `⏱️ Cliente sem responder há ${prazo.minutos} min. Atribuído a ${nome}.`,
          `Motivo registrado pelo agente: ${prazo.motivo}`,
        ].join("\n"),
      );
      await cliente.enviarMensagem(conversaId, acao.aviso.trim());
      await cliente.alternarStatus(conversaId, "open");
      await cliente.atribuir(conversaId, { assigneeId: achado.atendente.id });
      await entregarAoHumano(
        conversaId,
        `prazo vencido: cliente sem responder, atribuída a ${nome}`,
      );
      return { status: PrazoStatus.EXECUTADO, resultado: `atribuída a ${nome}` };
    }
  }
}

/** Nota que falha não desfaz o que já foi feito: registra no log e segue. */
async function notaInterna(cliente: ChatwootClient, conversaId: number, texto: string) {
  try {
    await cliente.enviarMensagem(conversaId, texto, { privado: true });
  } catch (erro) {
    logger.warn({ conversa: conversaId, erro }, "prazo: nota interna não foi gravada");
  }
}
