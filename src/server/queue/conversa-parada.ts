import { Queue } from "bullmq";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { EventoDeConversa } from "@/generated/prisma/enums";
import { FUSO_SEAHUB } from "@/lib/tempo";
import { reconciliar } from "@/server/agenda/reconciliacao";
import { getRedis } from "./conexao";

export const FILA_CONVERSA_PARADA = "conversa-parada";

/**
 * Dois tipos de job na mesma fila, e é a diferença que define esta origem.
 *
 * Os outros gatilhos de conversa são reativos: o Chatwoot avisa, e cada aviso é
 * um job. Aqui quem aciona é o relógio, e ninguém sabe sobre QUAIS conversas
 * antes de ir olhar — por isso a varredura é um job (barato, sem modelo) que
 * produz os jobs de análise (caros, um por conversa).
 *
 * Fazer tudo num job só foi o que deu no fluxo do n8n: 25 conversas em
 * sequência, 19 minutos de execução, e um teto de fato em quantas cabiam antes
 * de a coisa ficar impraticável.
 */
export type JobVarredura = { gatilhoId: string };

export type JobConversaParada = {
  gatilhoId: string;
  agentId: string;
  /** A entrega gravada em `WebhookEvent`: idempotência e rastro na tela. */
  webhookEventId: string;
  chatwootConversationId: number;
  inboxId: number | null;
  contatoNome: string | null;
  telefone: string | null;
  /** Nome do responsável no Chatwoot, já conferido como pessoa. */
  dono: string | null;
  /** Instante da última mensagem pública, em segundos. */
  ultimaMensagemEm: number;
  ultimoFalante: "cliente" | "equipe";
};

let fila: Queue<JobVarredura | JobConversaParada> | null = null;

export function getFilaConversaParada(): Queue<JobVarredura | JobConversaParada> {
  fila ??= new Queue<JobVarredura | JobConversaParada>(FILA_CONVERSA_PARADA, {
    connection: getRedis(),
    defaultJobOptions: {
      // Duas tentativas, como o agendamento e pelo mesmo motivo: não há cliente
      // esperando. O que falhar de vez espera a rodada de amanhã.
      attempts: 2,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { age: 7 * 24 * 3_600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    },
  });
  return fila;
}

/**
 * Enfileira a análise de UMA conversa.
 *
 * `jobId` pela entrega, como em toda fila daqui: se a varredura rodar duas
 * vezes na mesma rodada, a segunda não produz execução paga.
 */
export async function agendarConversaParada(dados: JobConversaParada) {
  return getFilaConversaParada().add("analisar", dados, {
    jobId: `parada-${dados.webhookEventId}`,
  });
}

/** `jobId` do BullMQ não aceita `:` — mesma regra do atendimento. */
export function idDoVarredor(gatilhoId: string) {
  return `varredura-${gatilhoId}`;
}

/**
 * Insere ou atualiza o relógio da varredura.
 *
 * ⚠ `tz` é obrigatório e não tem padrão seguro, exatamente como no agendamento:
 * o container roda em UTC, e "às 7h" sem fuso varre às 4h da manhã — quando
 * ninguém da equipe vai ler a nota antes de o dia começar.
 */
export async function sincronizarVarredor(gatilho: { id: string; cron: string }) {
  await getFilaConversaParada().upsertJobScheduler(
    idDoVarredor(gatilho.id),
    { pattern: gatilho.cron, tz: FUSO_SEAHUB },
    { name: "varrer", data: { gatilhoId: gatilho.id } },
  );
}

export async function removerVarredor(gatilhoId: string) {
  await getFilaConversaParada().removeJobScheduler(idDoVarredor(gatilhoId));
}

/**
 * Faz o Redis refletir o Postgres, como `reconciliarAgendadores`.
 *
 * Mesma razão de existir: o relógio vive no Redis, e um Redis limpo apagaria a
 * varredura em silêncio — a tela continuaria dizendo "ligado" e nada
 * dispararia nunca.
 */
export async function reconciliarVarredores(): Promise<{
  sincronizados: number;
  removidos: number;
}> {
  const ligados = await db.gatilhoDeConversa.findMany({
    where: {
      evento: EventoDeConversa.SEM_RESPOSTA,
      enabled: true,
      cron: { not: null },
      agent: { active: true, archivedAt: null },
    },
    select: { id: true, cron: true },
  });

  const fila = getFilaConversaParada();
  const existentes = (await fila.getJobSchedulers(0, 500)).map((a) => a.key);

  const plano = reconciliar(
    ligados.map((g) => idDoVarredor(g.id)),
    existentes.filter((k) => k.startsWith("varredura-")),
  );

  for (const gatilho of ligados) {
    try {
      await sincronizarVarredor({ id: gatilho.id, cron: gatilho.cron! });
    } catch (erro) {
      // Expressão inválida num gatilho não pode impedir os outros de subir.
      logger.error(
        { gatilhoId: gatilho.id, cron: gatilho.cron, erro },
        "não consegui sincronizar a varredura de conversas paradas",
      );
    }
  }

  for (const chave of plano.paraRemover) {
    try {
      await fila.removeJobScheduler(chave);
    } catch (erro) {
      logger.warn({ chave, erro }, "não consegui remover varredor órfão");
    }
  }

  return { sincronizados: ligados.length, removidos: plano.paraRemover.length };
}
