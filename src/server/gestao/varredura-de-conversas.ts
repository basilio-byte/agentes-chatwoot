import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { EventoDeConversa } from "@/generated/prisma/enums";
import { validarFrequencia } from "@/server/agenda/cron";
import {
  removerVarredor,
  sincronizarVarredor,
} from "@/server/queue/conversa-parada";
import { auditar, type Autor, type Desfecho } from "./autor";

/**
 * Configura e liga a varredura de conversas paradas — o gatilho `SEM_RESPOSTA`.
 *
 * Diferente dos outros dois gatilhos de conversa em uma coisa que muda o
 * código: ele tem RELÓGIO. Ligar não basta gravar no Postgres; é preciso pôr o
 * agendador no Redis na mesma operação, senão o gatilho fica "ligado" na tela e
 * não dispara até o próximo boot do worker — o silêncio sem rastro que este
 * projeto já pagou caro.
 */

/** Um dia inteiro de conversa parada é muito; um minuto não faz sentido. */
export const HORAS_MINIMAS = 1;
export const HORAS_MAXIMAS = 24 * 30;

/** Teto de execuções pagas por rodada. Acima disso, é decisão de orçamento. */
export const TETO_MINIMO = 1;
export const TETO_MAXIMO = 500;

const EVENTO = EventoDeConversa.SEM_RESPOSTA;

export type DadosDaVarredura = {
  cron: string;
  horasParadas: number;
  tetoPorRodada: number;
};

/**
 * Salva a configuração sem mexer no ligado. Criar pela primeira vez nasce
 * desligado — mesma doutrina de todo gatilho.
 */
export async function configurarVarredura(
  agentId: string,
  dados: DadosDaVarredura,
  autor: Autor,
): Promise<Desfecho> {
  const agente = await db.agent.findUnique({
    where: { id: agentId },
    select: { id: true },
  });
  if (!agente) return { erro: "Agente não encontrado." };

  const problema = conferir(dados);
  if (problema) return { erro: problema };

  const atual = await db.gatilhoDeConversa.findUnique({
    where: { agentId_evento: { agentId, evento: EVENTO } },
    select: { enabled: true },
  });

  await db.gatilhoDeConversa.upsert({
    where: { agentId_evento: { agentId, evento: EVENTO } },
    update: dados,
    // A exigência de resposta humana é da conversa encerrada e não se aplica:
    // aqui quem decide é `vereditoDaConversa`, que já exige pessoa dona.
    create: { agentId, evento: EVENTO, enabled: false, exigeAtendimentoHumano: false, ...dados },
  });

  // ⚠ Com o gatilho ligado, mudar o horário precisa chegar ao Redis agora. Sem
  // isto, a tela mostraria o horário novo e o relógio continuaria no antigo até
  // alguém reiniciar o worker.
  if (atual?.enabled) {
    const gatilho = await db.gatilhoDeConversa.findUnique({
      where: { agentId_evento: { agentId, evento: EVENTO } },
      select: { id: true },
    });
    if (gatilho) await tocarORelogio(gatilho.id, dados.cron);
  }

  await auditar(autor, "agent.sweep-trigger.updated", "Agent", agentId, dados);

  revalidatePath(`/agentes/${agentId}`);
  return { ok: "Configuração salva." };
}

/** Liga ou desliga a varredura, e põe ou tira o relógio do Redis. */
export async function definirVarredura(
  agentId: string,
  ligar: boolean,
  autor: Autor,
): Promise<Desfecho> {
  const agente = await db.agent.findUnique({
    where: { id: agentId },
    select: { active: true, archivedAt: true },
  });
  if (!agente) return { erro: "Agente não encontrado." };

  const atual = await db.gatilhoDeConversa.findUnique({
    where: { agentId_evento: { agentId, evento: EVENTO } },
    select: { id: true, cron: true },
  });

  if (ligar) {
    if (!agente.active || agente.archivedAt) {
      return {
        erro: "O agente está desligado ou arquivado. Ligue o agente antes — senão a varredura roda e cada conversa vira uma entrega ignorada.",
      };
    }
    if (!atual?.cron) {
      return { erro: "Defina o horário da varredura e salve antes de ligar." };
    }
  }

  const linha = await db.gatilhoDeConversa.upsert({
    where: { agentId_evento: { agentId, evento: EVENTO } },
    update: { enabled: ligar },
    // Sem linha, só chega aqui quem está desligando: nasce desligado.
    create: { agentId, evento: EVENTO, enabled: false, exigeAtendimentoHumano: false },
    select: { id: true, cron: true },
  });

  if (ligar) {
    await tocarORelogio(linha.id, linha.cron!);
  } else {
    try {
      await removerVarredor(linha.id);
    } catch (erro) {
      // Desligado no banco, o worker recusa a varredura na próxima rodada de
      // qualquer jeito — a reconferência está lá para isto. Vale seguir.
      logger.warn({ gatilhoId: linha.id, erro }, "não consegui tirar o varredor do Redis");
    }
  }

  await auditar(
    autor,
    ligar ? "agent.sweep-trigger.enabled" : "agent.sweep-trigger.disabled",
    "Agent",
    agentId,
  );

  revalidatePath(`/agentes/${agentId}`);
  return {
    ok: ligar
      ? "Ligado: a varredura roda no próximo horário marcado."
      : "Desligado.",
  };
}

/**
 * Põe o agendador no Redis.
 *
 * Falhar aqui com o gatilho ligado é grave — é a diferença entre "ligado" e
 * "ligado e disparando" —, mas não desfaz a gravação: a reconciliação do
 * próximo boot conserta, e o log diz o que houve.
 */
async function tocarORelogio(gatilhoId: string, cron: string) {
  try {
    await sincronizarVarredor({ id: gatilhoId, cron });
  } catch (erro) {
    logger.error(
      { gatilhoId, cron, erro },
      "não consegui pôr o varredor no Redis — a reconciliação do próximo boot conserta",
    );
  }
}

function conferir(dados: DadosDaVarredura): string | null {
  const veredito = validarFrequencia(dados.cron);
  if (!veredito.pode) return veredito.erro;

  if (
    !Number.isInteger(dados.horasParadas) ||
    dados.horasParadas < HORAS_MINIMAS ||
    dados.horasParadas > HORAS_MAXIMAS
  ) {
    return `As horas paradas precisam ficar entre ${HORAS_MINIMAS} e ${HORAS_MAXIMAS}.`;
  }

  if (
    !Number.isInteger(dados.tetoPorRodada) ||
    dados.tetoPorRodada < TETO_MINIMO ||
    dados.tetoPorRodada > TETO_MAXIMO
  ) {
    return `O teto por rodada precisa ficar entre ${TETO_MINIMO} e ${TETO_MAXIMO}.`;
  }

  return null;
}
