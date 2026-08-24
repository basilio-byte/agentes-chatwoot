"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigirPapel, exigirSessao } from "@/server/auth-guard";
import { UserRole } from "@/generated/prisma/enums";
import {
  expressaoDoAtalho,
  lerCron,
  validarFrequencia,
  type Atalho,
} from "@/server/agenda/cron";
import {
  removerAgendador,
  sincronizarAgendador,
} from "@/server/queue/agendamento";

export type EstadoAgendamento = {
  ok?: string;
  erro?: string;
  camposComErro?: Record<string, string>;
};

export type AgendamentoNaTela = {
  id: string;
  nome: string;
  cron: string;
  instrucao: string;
  enabled: boolean;
  toleranciaMinutos: number;
  ultimaExecucaoEm: Date | null;
  ultimoResultado: string | null;
  ultimoDetalhe: string | null;
  falhasConsecutivas: number;
  pausadoAutomaticamenteEm: Date | null;
  pausadoAutomaticamenteMotivo: string | null;
  /** Próximas execuções, já calculadas no fuso de São Paulo. */
  proximas: Date[];
  /** Preenchido quando a expressão guardada não é mais legível. */
  erroDoCron: string | null;
};

/**
 * Agendamentos de um agente, com as próximas execuções já resolvidas.
 *
 * A previsão vem do cron, e não do Redis, de propósito: é a mesma conta que o
 * BullMQ faz, e assim a tela funciona igual com o worker fora do ar — que é
 * justamente quando alguém abre a tela para entender o que houve.
 */
export async function listarAgendamentos(
  agentId: string,
): Promise<AgendamentoNaTela[]> {
  await exigirSessao();

  const linhas = await db.agentSchedule.findMany({
    where: { agentId },
    orderBy: { createdAt: "asc" },
  });

  return linhas.map((l) => {
    const leitura = lerCron(l.cron);
    return {
      id: l.id,
      nome: l.nome,
      cron: l.cron,
      instrucao: l.instrucao,
      enabled: l.enabled,
      toleranciaMinutos: l.toleranciaMinutos,
      ultimaExecucaoEm: l.ultimaExecucaoEm,
      ultimoResultado: l.ultimoResultado,
      ultimoDetalhe: l.ultimoDetalhe,
      falhasConsecutivas: l.falhasConsecutivas,
      pausadoAutomaticamenteEm: l.pausadoAutomaticamenteEm,
      pausadoAutomaticamenteMotivo: l.pausadoAutomaticamenteMotivo,
      proximas: leitura.valida ? leitura.proximas : [],
      erroDoCron: leitura.valida ? null : leitura.erro,
    };
  });
}

/**
 * Prévia das próximas execuções, para a tela conferir antes de salvar.
 *
 * É a defesa contra o erro que não grita: expressão certa no fuso errado
 * dispara três horas fora todo dia. Ver a hora escrita por extenso, em horário
 * de São Paulo, é o que permite alguém dizer "não era isso que eu queria".
 */
export async function preverAgendamento(
  expressao: string,
): Promise<EstadoAgendamento & { proximas?: Date[] }> {
  await exigirSessao();

  const veredito = validarFrequencia(expressao);
  if (!veredito.pode) return { erro: veredito.erro };
  return { proximas: veredito.proximas };
}

/** Monta a expressão a partir dos atalhos da tela. */
export async function montarExpressao(args: {
  atalho: Atalho;
  hora: number;
  minuto: number;
  diaDaSemana?: number;
  diaDoMes?: number;
  aCadaHoras?: number;
}): Promise<string> {
  await exigirSessao();
  return expressaoDoAtalho(args);
}

export async function salvarAgendamento(
  agentId: string,
  _estado: EstadoAgendamento,
  formData: FormData,
): Promise<EstadoAgendamento> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const id = String(formData.get("id") ?? "").trim();
  const nome = String(formData.get("nome") ?? "").trim();
  const cron = String(formData.get("cron") ?? "").trim();
  const instrucao = String(formData.get("instrucao") ?? "").trim();
  const tolerancia = Number(formData.get("toleranciaMinutos") ?? 60);

  const camposComErro: Record<string, string> = {};
  if (nome.length < 2) camposComErro.nome = "Dê um nome ao agendamento";
  if (instrucao.length < 10) {
    camposComErro.instrucao =
      "Escreva o que o agente deve fazer — é isto que vira a mensagem do turno";
  }
  if (!Number.isInteger(tolerancia) || tolerancia < 0 || tolerancia > 1440) {
    camposComErro.toleranciaMinutos = "Use um valor entre 0 e 1440 minutos";
  }

  const veredito = validarFrequencia(cron);
  if (!veredito.pode) camposComErro.cron = veredito.erro;

  if (Object.keys(camposComErro).length > 0) {
    return { erro: "Confira os campos.", camposComErro };
  }

  const dados = { nome, cron, instrucao, toleranciaMinutos: tolerancia };

  const salvo = id
    ? await db.agentSchedule.update({
        where: { id },
        data: {
          ...dados,
          // Editar um agendamento que o sistema desligou sozinho é a forma de
          // dizer "consertei": o motivo sai, mas ele continua desligado até
          // alguém ligar de propósito.
          pausadoAutomaticamenteEm: null,
          pausadoAutomaticamenteMotivo: null,
          falhasConsecutivas: 0,
        },
      })
    : await db.agentSchedule.create({
        data: { ...dados, agentId, createdById: sessao.user.id },
      });

  // Só sincroniza se estiver ligado. Salvar não liga — mesma doutrina de
  // `Agent.active` e `AgentTrigger.enabled`.
  if (salvo.enabled) {
    try {
      await sincronizarAgendador(salvo);
    } catch (erro) {
      return {
        erro: `Agendamento salvo, mas não consegui programar o relógio: ${
          erro instanceof Error ? erro.message : "falha no Redis"
        }. Ele volta a valer quando o worker reiniciar.`,
      };
    }
  }

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: id ? "schedule.updated" : "schedule.created",
      entity: "AgentSchedule",
      entityId: salvo.id,
    },
  });

  revalidatePath(`/agentes/${agentId}`);
  return {
    ok: salvo.enabled
      ? "Agendamento salvo e programado."
      : "Agendamento salvo. Ele só passa a rodar depois de ligado.",
  };
}

export async function alternarAgendamento(
  id: string,
  ligar: boolean,
): Promise<EstadoAgendamento> {
  const sessao = await exigirPapel(UserRole.ADMIN);

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

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: ligar ? "schedule.enabled" : "schedule.disabled",
      entity: "AgentSchedule",
      entityId: id,
    },
  });

  revalidatePath(`/agentes/${schedule.agent.id}`);
  return { ok: ligar ? "Agendamento ligado." : "Agendamento desligado." };
}

export async function excluirAgendamento(
  id: string,
): Promise<EstadoAgendamento> {
  const sessao = await exigirPapel(UserRole.ADMIN);

  const schedule = await db.agentSchedule.findUnique({
    where: { id },
    select: { agentId: true },
  });
  if (!schedule) return { erro: "Agendamento não encontrado." };

  // Tira do relógio ANTES de apagar a linha: na ordem inversa, uma falha no
  // meio deixaria um agendador órfão disparando para um id que não existe mais.
  await removerAgendador(id).catch(() => {});
  await db.agentSchedule.delete({ where: { id } });

  await db.auditLog.create({
    data: {
      userId: sessao.user.id,
      action: "schedule.deleted",
      entity: "AgentSchedule",
      entityId: id,
    },
  });

  revalidatePath(`/agentes/${schedule.agentId}`);
  return { ok: "Agendamento excluído." };
}
