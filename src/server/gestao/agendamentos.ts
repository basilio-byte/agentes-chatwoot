import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { validarFrequencia } from "@/server/agenda/cron";
import {
  removerAgendador,
  sincronizarAgendador,
} from "@/server/queue/agendamento";
import { auditar, type Autor, type Desfecho } from "./autor";

/**
 * Liga ou desliga um agendamento — no banco E no relógio do Redis.
 *
 * Só desligar no banco continuaria disparando até o próximo boot do worker, que
 * é quando a reconciliação acerta as duas pontas.
 */
export async function definirAgendamento(
  id: string,
  ligar: boolean,
  autor: Autor,
): Promise<Desfecho> {
  const schedule = await db.agentSchedule.findUnique({
    where: { id },
    include: { agent: { select: { id: true, active: true, archivedAt: true } } },
  });
  if (!schedule) return { erro: "Agendamento não encontrado." };

  if (ligar) {
    const veredito = validarFrequencia(schedule.cron);
    if (!veredito.pode) {
      return { erro: `Não dá para ligar: ${veredito.erro}` };
    }
    // Ligar o agendamento de um agente desligado criaria disparos que só
    // servem para virar "pulado" — melhor dizer isso do que fingir que ligou.
    if (!schedule.agent.active || schedule.agent.archivedAt) {
      return {
        erro: "O agente está desligado ou arquivado. Ligue o agente antes — senão o agendamento dispara e não faz nada.",
      };
    }
  }

  await db.agentSchedule.update({
    where: { id },
    data: {
      enabled: ligar,
      ...(ligar
        ? { pausadoAutomaticamenteEm: null, pausadoAutomaticamenteMotivo: null, falhasConsecutivas: 0 }
        : {}),
    },
  });

  try {
    if (ligar) await sincronizarAgendador(schedule);
    else await removerAgendador(id);
  } catch (erro) {
    return {
      erro: `Estado salvo, mas o relógio não respondeu: ${
        erro instanceof Error ? erro.message : "falha no Redis"
      }. A reconciliação do worker acerta no próximo boot.`,
    };
  }

  await auditar(
    autor,
    ligar ? "schedule.enabled" : "schedule.disabled",
    "AgentSchedule",
    id,
  );

  revalidatePath(`/agentes/${schedule.agent.id}`);
  return { ok: ligar ? "Agendamento ligado." : "Agendamento desligado." };
}
