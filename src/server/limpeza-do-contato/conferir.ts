import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { IntegrationProvider } from "@/generated/prisma/enums";
import { lerConversaResolvida } from "@/server/conversa-encerrada/evento";
import { ChatwootApiError } from "@/server/integrations/chatwoot/client";
import { clienteDeLeitura } from "@/server/integrations/chatwoot/credenciais";
import {
  camposParaLimpar,
  chaveDaLimpeza,
  CONFERIR_A_CADA_MS,
  decidirLimpeza,
  ESPERA_MS,
  lerConfigDaLimpeza,
  POR_RODADA,
  PROVIDER_LIMPEZA,
  VALIDADE_MS,
  type ConfigDaLimpeza,
} from "./regras";

/**
 * A limpeza dos campos do contato depois da resolução (regras em `regras.ts`).
 *
 * Duas pontas, como a conversa encerrada:
 * - **Na resolução** (webhook de conta), `registrarLimpezaDoContato` grava uma
 *   linha `pendente` em `WebhookEvent` (provider `LIMPEZA_CONTATO`). A unique da
 *   linha segura a reentrega do Chatwoot. Vale para resolução de qualquer caixa,
 *   feita por pessoa, pela pesquisa de satisfação ou pelo prazo do agente.
 * - **No vigia**, `limparContatosResolvidos` pega as pendentes com mais de 15 min,
 *   confere ao vivo e limpa. "Limpar" é remover a chave do `custom_attributes`
 *   pelo endpoint próprio (`removerAtributosDoContato`: o `PUT` do contato faz
 *   merge e não apaga), e o contato é lido DE VOLTA antes de registrar "limpa".
 *   O resto do contato fica intacto.
 *
 * O rastro mostra QUAIS campos saíram, nunca os valores.
 */

async function configAtual(): Promise<ConfigDaLimpeza> {
  const registro = await db.integration.findUnique({
    where: { provider: IntegrationProvider.CHATWOOT },
    select: { config: true },
  });
  return lerConfigDaLimpeza(registro?.config);
}

/** Na resolução: marca a limpeza para daqui a 15 min. Nunca lança. */
export async function registrarLimpezaDoContato(payload: unknown, agora = Date.now()) {
  const resolvida = lerConversaResolvida(payload, agora);
  if (!resolvida) return false;
  try {
    if (!(await configAtual()).ligada) return false;
    await db.webhookEvent.create({
      data: {
        provider: PROVIDER_LIMPEZA,
        externalId: chaveDaLimpeza(resolvida.conversationId, resolvida.resolvidaEm),
        eventType: `conversa #${resolvida.conversationId} resolvida`,
        // Sem nome nem telefone: Entregas é lido pela equipe inteira.
        payload: {
          conversa: resolvida.conversationId,
          inbox: resolvida.inboxId,
          resolvidaEm: resolvida.resolvidaEm,
        },
        resultado: "pendente",
      },
    });
    return true;
  } catch (erro) {
    const conflito =
      typeof erro === "object" && erro !== null && (erro as { code?: string }).code === "P2002";
    if (!conflito) {
      logger.warn({ erro, conversa: resolvida.conversationId }, "limpeza do contato: não registrei");
    }
    return false;
  }
}

let ultimaConferencia = 0;
let rodando = false;

export type RodadaDaLimpeza = {
  acao: "cedo" | "em andamento" | "desligada" | "sem chatwoot" | "conferido";
  limpas?: number;
  puladas?: number;
  semNada?: number;
  expiradas?: number;
  falhas?: number;
};

type Pendente = { id: string; payload: unknown; createdAt: Date };

/** Chamada pelo vigia a cada minuto; confere de fato a cada `CONFERIR_A_CADA_MS`. */
export async function limparContatosResolvidos(
  agora = new Date(),
  opcoes: { forcar?: boolean } = {},
): Promise<RodadaDaLimpeza> {
  if (rodando) return { acao: "em andamento" };
  if (!opcoes.forcar && agora.getTime() - ultimaConferencia < CONFERIR_A_CADA_MS) {
    return { acao: "cedo" };
  }
  ultimaConferencia = agora.getTime();
  rodando = true;
  try {
    return await rodar(agora);
  } finally {
    rodando = false;
  }
}

/** Só para teste: esquece o relógio entre um caso e outro. */
export function reiniciarRelogioDaLimpeza() {
  ultimaConferencia = 0;
  rodando = false;
}

async function rodar(agora: Date): Promise<RodadaDaLimpeza> {
  const config = await configAtual();
  // Desligada: as pendentes ficam onde estão e expiram sozinhas.
  if (!config.ligada) return { acao: "desligada" };

  const rodada: RodadaDaLimpeza = {
    acao: "conferido",
    limpas: 0,
    puladas: 0,
    semNada: 0,
    expiradas: 0,
    falhas: 0,
  };

  // Worker que ficou fora do ar: limpar dois dias depois apagaria o que o
  // atendimento seguinte já preencheu.
  const { count: expiradas } = await db.webhookEvent.updateMany({
    where: {
      provider: PROVIDER_LIMPEZA,
      resultado: "pendente",
      createdAt: { lt: new Date(agora.getTime() - VALIDADE_MS) },
    },
    data: { resultado: "expirada", detalhe: "pendente por mais de 48 h", processedAt: agora },
  });
  rodada.expiradas = expiradas;

  const pendentes: Pendente[] = await db.webhookEvent.findMany({
    where: {
      provider: PROVIDER_LIMPEZA,
      resultado: "pendente",
      createdAt: { lte: new Date(agora.getTime() - ESPERA_MS) },
    },
    orderBy: { createdAt: "asc" },
    take: POR_RODADA,
    select: { id: true, payload: true, createdAt: true },
  });
  if (!pendentes.length) return rodada;

  const chatwoot = await clienteDeLeitura();
  if (!chatwoot) return { ...rodada, acao: "sem chatwoot" };

  for (const p of pendentes) {
    const conversa = Number((p.payload as { conversa?: unknown } | null)?.conversa);
    // Trava: duas rodadas (ou réplicas) nunca tratam a mesma linha.
    const pego = await db.webhookEvent.updateMany({
      where: { id: p.id, resultado: "pendente" },
      data: { resultado: "limpando" },
    });
    if (pego.count !== 1) continue;

    const fechar = (resultado: string, detalhe: string) =>
      db.webhookEvent.update({
        where: { id: p.id },
        data: { resultado, detalhe: detalhe.slice(0, 500), processedAt: new Date() },
      });

    try {
      if (!Number.isInteger(conversa) || conversa <= 0) {
        await fechar("pulada", "linha sem conversa");
        rodada.puladas! += 1;
        continue;
      }

      // Resolvida de novo depois desta: a limpeza vai com a resolução mais nova.
      const maisNova = await db.webhookEvent.findFirst({
        where: {
          provider: PROVIDER_LIMPEZA,
          resultado: "pendente",
          externalId: { startsWith: `conversa:${conversa}:` },
          createdAt: { gt: p.createdAt },
        },
        select: { id: true },
      });
      if (maisNova) {
        await fechar("pulada", "a conversa foi resolvida de novo depois; vale a resolução mais nova");
        rodada.puladas! += 1;
        continue;
      }

      const aoVivo = await chatwoot.cliente.obterConversa(conversa);
      const outras =
        aoVivo.contactId != null ? await chatwoot.cliente.conversasDoContato(aoVivo.contactId) : [];
      const decisao = decidirLimpeza({
        conversaId: conversa,
        status: aoVivo.status,
        contactId: aoVivo.contactId,
        outras,
      });
      if (decisao.acao === "pular") {
        await fechar("pulada", decisao.motivo);
        rodada.puladas! += 1;
        continue;
      }

      const contato = await chatwoot.cliente.obterContato(aoVivo.contactId!);
      const campos = camposParaLimpar(contato.atributos, config.campos);
      if (!campos.length) {
        await fechar("nada a limpar", "nenhum dos campos da lista estava preenchido");
        rodada.semNada! += 1;
        continue;
      }

      await chatwoot.cliente.removerAtributosDoContato(aoVivo.contactId!, campos);

      // ⚠ Lê de volta, e só então diz "limpa". Chamada sem erro não prova campo
      // apagado: a primeira limpeza real (conversa 14665, 17/11/2026) registrou
      // "limpa" com os valores ainda no contato, porque o `PUT` do Chatwoot faz
      // merge e nunca apaga. O que o Chatwoot responde não vale; o contato vale.
      const depois = await chatwoot.cliente.obterContato(aoVivo.contactId!);
      const restam = camposParaLimpar(depois.atributos, campos);
      if (restam.length) {
        await fechar(
          "falhou",
          `o Chatwoot aceitou a remoção, mas estes campos continuam no contato: ${restam.join(", ")}`,
        );
        rodada.falhas! += 1;
        continue;
      }
      await fechar("limpa", `campos limpos: ${campos.join(", ")}`);
      rodada.limpas! += 1;
    } catch (erro) {
      const motivo = erro instanceof Error ? erro.message : String(erro);
      rodada.falhas! += 1;
      // Recusa clara (conversa ou contato que não existe mais): voltar para a fila
      // a deixaria na frente das outras por 48 h, a cada rodada.
      if (
        erro instanceof ChatwootApiError &&
        erro.status >= 400 &&
        erro.status < 500 &&
        erro.status !== 408 &&
        erro.status !== 429
      ) {
        await fechar("falhou", `o Chatwoot recusou: ${motivo}`).catch(() => {});
        continue;
      }
      // Chatwoot fora do ar: volta para a fila, e a validade de 48 h segura o fim.
      logger.warn({ conversa, erro: motivo }, "limpeza do contato: falhou, tenta de novo");
      await db.webhookEvent
        .update({ where: { id: p.id }, data: { resultado: "pendente" } })
        .catch(() => {});
    }
  }

  return rodada;
}
