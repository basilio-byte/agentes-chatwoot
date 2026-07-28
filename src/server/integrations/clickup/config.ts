import { z } from "zod";

/** Config não-sensível da integração — vale para todos os agentes. */
export const clickupConfigSchema = z.object({
  /** Workspace (a API chama de "team"). GET /team lista os disponíveis. */
  teamId: z.string().min(1, "Informe o id do workspace"),
  /**
   * Lista padrão para criar tarefas quando o agente não especificar.
   * Sem ela, o agente precisa escolher a lista a cada criação.
   */
  defaultListId: z.string().optional().or(z.literal("")),
  /**
   * Limita o que o agente enxerga. Vazio = workspace inteiro.
   * Útil para não expor espaços internos ao atendimento.
   */
  spaceIdsPermitidos: z.array(z.string()).default([]),
});

export type ClickUpConfig = z.infer<typeof clickupConfigSchema>;

/** Token pessoal (`pk_...`) ou access token de OAuth. */
export const clickupSegredoSchema = z.object({
  apiToken: z.string().min(10, "Token muito curto"),
});

export type ClickUpSegredo = z.infer<typeof clickupSegredoSchema>;
