import { db } from "@/lib/db";
import { MotorDoAgente } from "@/generated/prisma/enums";
import { claudeMaxConfigurado, listarModelosClaudeMax } from "@/server/agents/claude-max";
import { auditar, type Autor, type Desfecho } from "./autor";

/**
 * A chave geral OpenRouter ⇄ Claude MAX e a escolha de cada agente.
 *
 * Mora aqui, e não na server action, pela regra do projeto: o que um agente
 * pode ou não fazer vale para as duas portas (painel e MCP). Ver `agents/motor.ts`
 * para o que cada estado significa em execução.
 */

async function modeloValido(id: string): Promise<boolean> {
  const { modelos } = await listarModelosClaudeMax();
  return modelos.some((m) => m.id === id);
}

export async function salvarMotorGlobal(
  dados: { claudeMaxLigado: boolean; modeloPadrao: string },
  autor: Autor,
): Promise<Desfecho> {
  const modeloPadrao = dados.modeloPadrao.trim();

  // Ligar sem proxy configurado seria uma chave que diz "Claude MAX" e roda
  // tudo na OpenRouter — o painel mentindo sobre o próprio estado.
  if (dados.claudeMaxLigado && !claudeMaxConfigurado()) {
    return {
      erro: "O proxy não está configurado: defina CLAUDE_MAX_BASE_URL e CLAUDE_MAX_API_KEY no Easypanel antes de ligar.",
    };
  }
  if (!modeloPadrao || !(await modeloValido(modeloPadrao))) {
    return { erro: `"${modeloPadrao}" não é um modelo que o proxy oferece.` };
  }

  await db.motorDosAgentes.upsert({
    where: { id: "unico" },
    update: { claudeMaxLigado: dados.claudeMaxLigado, modeloPadrao, atualizadoPorId: autor.userId },
    create: {
      id: "unico",
      claudeMaxLigado: dados.claudeMaxLigado,
      modeloPadrao,
      atualizadoPorId: autor.userId,
    },
  });
  await auditar(autor, "motor.global.updated", "MotorDosAgentes", "unico", {
    claudeMaxLigado: dados.claudeMaxLigado,
    modeloPadrao,
  });

  return {
    ok: dados.claudeMaxLigado
      ? `Claude MAX ligado. Os agentes que seguem a chave geral passam a usar o ${modeloPadrao} a partir da próxima mensagem; se o proxy falhar, a chamada volta sozinha para a OpenRouter.`
      : "Chave geral na OpenRouter. Os agentes que seguem a chave geral voltam para a OpenRouter a partir da próxima mensagem.",
  };
}

const MOTORES = Object.values(MotorDoAgente) as string[];

export async function definirMotorDoAgente(
  agentId: string,
  dados: { motor: string; modeloClaudeMax: string },
  autor: Autor,
): Promise<Desfecho> {
  if (!MOTORES.includes(dados.motor)) return { erro: "Motor desconhecido." };
  const motor = dados.motor as MotorDoAgente;
  const modelo = dados.modeloClaudeMax.trim() || null;

  if (motor === MotorDoAgente.CLAUDE_MAX && !claudeMaxConfigurado()) {
    return {
      erro: "O proxy não está configurado: defina CLAUDE_MAX_BASE_URL e CLAUDE_MAX_API_KEY no Easypanel antes de fixar um agente nele.",
    };
  }
  if (modelo && !(await modeloValido(modelo))) {
    return { erro: `"${modelo}" não é um modelo que o proxy oferece.` };
  }

  const agente = await db.agent.findUnique({ where: { id: agentId }, select: { id: true } });
  if (!agente) return { erro: "Agente não encontrado." };

  await db.agent.update({
    where: { id: agentId },
    data: { motor, modeloClaudeMax: modelo, updatedById: autor.userId },
  });
  await auditar(autor, "agent.motor.updated", "Agent", agentId, {
    motor,
    modeloClaudeMax: modelo,
  });

  const frase: Record<MotorDoAgente, string> = {
    PADRAO: "Este agente segue a chave geral.",
    OPENROUTER: "Este agente fica na OpenRouter, qualquer que seja a chave geral.",
    CLAUDE_MAX: "Este agente fica no Claude MAX, qualquer que seja a chave geral. Se o proxy falhar, a chamada volta sozinha para a OpenRouter.",
  };
  return { ok: `${frase[motor]} Vale a partir da próxima mensagem.` };
}
