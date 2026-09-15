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

// ---------------------------------------------------------------------------
// Checkbox marcado
// ---------------------------------------------------------------------------

/**
 * Outro agente ligado que já escuta algum destes checkboxes.
 *
 * Dois agentes no mesmo checkbox rodam os dois, e no CRM isso é task em dobro.
 * Melhor recusar ao ligar do que descobrir pela task.
 */
async function conflitoDeCheckbox(
  agentId: string,
  atributos: string[],
): Promise<string | null> {
  if (atributos.length === 0) return null;

  const outro = await db.gatilhoDeConversa.findFirst({
    where: {
      evento: EventoDeConversa.ATRIBUTO_MARCADO,
      enabled: true,
      agentId: { not: agentId },
      atributos: { hasSome: atributos },
      agent: { archivedAt: null },
    },
    select: { atributos: true, agent: { select: { name: true } } },
  });
  if (!outro) return null;

  const repetidos = outro.atributos.filter((a) => atributos.includes(a));
  return `O checkbox ${repetidos.join(", ")} já aciona o agente "${outro.agent.name}". Desligue o gatilho de lá antes: com os dois ligados, os dois rodam.`;
}

/**
 * Salva os checkboxes que acionam o agente, sem mexer no ligado.
 *
 * Criar pela primeira vez nasce desligado. Com o gatilho ligado, a lista não
 * pode ficar vazia — seria um "ligado" que nunca dispara — nem ganhar checkbox
 * que outro agente ligado já escuta.
 */
export async function configurarGatilhoDeCheckbox(
  agentId: string,
  dados: { atributos: string[] },
  autor: Autor,
): Promise<Desfecho> {
  const agente = await db.agent.findUnique({
    where: { id: agentId },
    select: { id: true },
  });
  if (!agente) return { erro: "Agente não encontrado." };

  const atual = await db.gatilhoDeConversa.findUnique({
    where: { agentId_evento: { agentId, evento: EventoDeConversa.ATRIBUTO_MARCADO } },
    select: { enabled: true },
  });

  if (atual?.enabled) {
    if (dados.atributos.length === 0) {
      return { erro: "O gatilho está ligado: desligue antes de tirar todos os checkboxes." };
    }
    const conflito = await conflitoDeCheckbox(agentId, dados.atributos);
    if (conflito) return { erro: conflito };
  }

  await db.gatilhoDeConversa.upsert({
    where: { agentId_evento: { agentId, evento: EventoDeConversa.ATRIBUTO_MARCADO } },
    update: { atributos: dados.atributos },
    // Quem marca o checkbox é uma pessoa da equipe: a exigência de resposta
    // humana, que é da conversa encerrada, não se aplica e fica desligada.
    create: {
      agentId,
      evento: EventoDeConversa.ATRIBUTO_MARCADO,
      enabled: false,
      exigeAtendimentoHumano: false,
      atributos: dados.atributos,
    },
  });

  await auditar(autor, "agent.checkbox-trigger.updated", "Agent", agentId, {
    atributos: dados.atributos,
  });

  revalidatePath(`/agentes/${agentId}`);
  return { ok: "Configuração salva." };
}

/** Liga ou desliga o gatilho "checkbox marcado". */
export async function definirGatilhoDeCheckbox(
  agentId: string,
  ligar: boolean,
  autor: Autor,
): Promise<Desfecho> {
  const agente = await db.agent.findUnique({
    where: { id: agentId },
    select: { active: true, archivedAt: true },
  });
  if (!agente) return { erro: "Agente não encontrado." };

  if (ligar) {
    if (!agente.active || agente.archivedAt) {
      return {
        erro: "O agente está desligado ou arquivado. Ligue o agente antes — senão cada checkbox marcado vira uma entrega ignorada.",
      };
    }

    const atual = await db.gatilhoDeConversa.findUnique({
      where: { agentId_evento: { agentId, evento: EventoDeConversa.ATRIBUTO_MARCADO } },
      select: { atributos: true },
    });
    if (!atual || atual.atributos.length === 0) {
      return { erro: "Cadastre ao menos um checkbox e salve antes de ligar." };
    }

    const conflito = await conflitoDeCheckbox(agentId, atual.atributos);
    if (conflito) return { erro: conflito };
  }

  await db.gatilhoDeConversa.upsert({
    where: { agentId_evento: { agentId, evento: EventoDeConversa.ATRIBUTO_MARCADO } },
    update: { enabled: ligar },
    // Sem linha, só chega aqui quem está desligando: nasce desligado.
    create: {
      agentId,
      evento: EventoDeConversa.ATRIBUTO_MARCADO,
      enabled: false,
      exigeAtendimentoHumano: false,
    },
  });

  await auditar(
    autor,
    ligar ? "agent.checkbox-trigger.enabled" : "agent.checkbox-trigger.disabled",
    "Agent",
    agentId,
  );

  revalidatePath(`/agentes/${agentId}`);
  return {
    ok: ligar ? "Ligado: o próximo checkbox marcado já aciona o agente." : "Desligado.",
  };
}
