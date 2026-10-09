import { ClickUpApiError } from "@/server/integrations/clickup/client";
import { aindaVale } from "@/server/integrations/clickup/repeticao";
import type { TaskRegistrada } from "./mensagem";

/**
 * Das tasks que este agente criou na conversa, as que AINDA barram uma nova.
 *
 * A trava do checkbox nasceu da conversa 10912 (a task da manhã ganhou uma
 * duplicata à tarde) e olhava só "já criei uma nesta conversa nos últimos 30
 * dias". A conversa de WhatsApp dura meses e quem reserva toda semana (cliente
 * avulsa, conversa 14342 em 05/10/2026) pede outra reserva por ela: com a task
 * anterior já GANHA, fechada, arquivada ou apagada, é oportunidade nova. Mesma
 * régua de `clickup_criar_tarefa` (`aindaVale`), para as duas travas não
 * discordarem.
 *
 * ⚠ Na dúvida, BARRA: sem o id da task, sem o ClickUp ou com erro que não seja
 * "apagada" (404), a task continua valendo. Soltar a trava por soluço recria o
 * buraco da task em dobro.
 */
export async function tasksQueAindaBarram(
  tasks: TaskRegistrada[],
  obterTarefa: (id: string) => Promise<Parameters<typeof aindaVale>[0]>,
): Promise<TaskRegistrada[]> {
  const restantes: TaskRegistrada[] = [];
  for (const task of tasks) {
    if (!task.id) {
      restantes.push(task);
      continue;
    }
    try {
      if (aindaVale(await obterTarefa(task.id))) restantes.push(task);
    } catch (erro) {
      // 404: task apagada, não vale mais. Qualquer outra falha: não dá para saber.
      if (!(erro instanceof ClickUpApiError && erro.status === 404)) restantes.push(task);
    }
  }
  return restantes;
}
