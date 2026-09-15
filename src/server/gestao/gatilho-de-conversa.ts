import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { EventoDeConversa } from "@/generated/prisma/enums";
import { auditar, type Autor, type Desfecho } from "./autor";

const LIMITE_DE_CONTAS = 20;
const LIMITE_DO_NOME = 80;

/**
 * A lista de contas de automação como a tela manda: uma por linha, ou separadas
 * por vírgula ou ponto e vírgula — é o que sai de um copiar e colar.
 */
export function lerContasDeAutomacao(texto: string): string[] {
  const vistas = new Set<string>();
  const contas: string[] = [];

  for (const bruta of texto.split(/[\n,;]+/)) {
    const nome = bruta.replace(/\s+/g, " ").trim().slice(0, LIMITE_DO_NOME);
    const chave = nome.toLowerCase();
    if (!nome || vistas.has(chave)) continue;
    vistas.add(chave);
    contas.push(nome);
  }

  return contas.slice(0, LIMITE_DE_CONTAS);
}

/**
 * Salva a configuração do gatilho "conversa resolvida" sem mexer no ligado.
 *
 * Criar pela primeira vez nasce desligado — mesma doutrina de todo gatilho.
 */
export async function configurarGatilhoDeConversa(
  agentId: string,
  dados: { exigeAtendimentoHumano: boolean; contasDeAutomacao: string[] },
  autor: Autor,
): Promise<Desfecho> {
  const agente = await db.agent.findUnique({
    where: { id: agentId },
    select: { id: true },
  });
  if (!agente) return { erro: "Agente não encontrado." };

  await db.gatilhoDeConversa.upsert({
    where: { agentId_evento: { agentId, evento: EventoDeConversa.RESOLVIDA } },
    update: dados,
    create: { agentId, evento: EventoDeConversa.RESOLVIDA, enabled: false, ...dados },
  });

  await auditar(autor, "agent.conversation-trigger.updated", "Agent", agentId, {
    exigeAtendimentoHumano: dados.exigeAtendimentoHumano,
    contasDeAutomacao: dados.contasDeAutomacao,
  });

  revalidatePath(`/agentes/${agentId}`);
  return { ok: "Configuração salva." };
}

/**
 * Liga ou desliga o gatilho "conversa resolvida".
 *
 * Ligar o gatilho de um agente desligado criaria execuções que só servem para
 * virar "ignorado" — melhor dizer isso do que fingir que ligou, como no
 * agendamento.
 */
export async function definirGatilhoDeConversa(
  agentId: string,
  ligar: boolean,
  autor: Autor,
): Promise<Desfecho> {
  const agente = await db.agent.findUnique({
    where: { id: agentId },
    select: { active: true, archivedAt: true },
  });
  if (!agente) return { erro: "Agente não encontrado." };

  if (ligar && (!agente.active || agente.archivedAt)) {
    return {
      erro: "O agente está desligado ou arquivado. Ligue o agente antes — senão cada conversa resolvida vira uma entrega ignorada.",
    };
  }

  await db.gatilhoDeConversa.upsert({
    where: { agentId_evento: { agentId, evento: EventoDeConversa.RESOLVIDA } },
    update: { enabled: ligar },
    create: { agentId, evento: EventoDeConversa.RESOLVIDA, enabled: ligar },
  });

  await auditar(
    autor,
    ligar ? "agent.conversation-trigger.enabled" : "agent.conversation-trigger.disabled",
    "Agent",
    agentId,
  );

  revalidatePath(`/agentes/${agentId}`);
  return {
    ok: ligar
      ? "Ligado: a próxima conversa resolvida já aciona o agente."
      : "Desligado.",
  };
}
