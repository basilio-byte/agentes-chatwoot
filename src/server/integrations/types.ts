import type { z } from "zod";
import type { IntegrationProvider } from "@/generated/prisma/enums";

/**
 * Contrato único de integração.
 *
 * Adicionar ClickUp ou Conexa = criar um módulo que exporta um
 * `IntegrationDefinition` e registrá-lo em `registry.ts`. Nada além disso muda.
 */

/**
 * Pedido de transferência que uma tool deixa para quem conduz o turno.
 *
 * A tool **não** executa a passagem: ela só registra a intenção. Quem envia o
 * aviso ao cliente e troca de agente é o worker — assim todo envio ao cliente
 * sai de um lugar só, e uma transferência que falha não deixa um "vou te
 * passar para o colega" solto na conversa.
 */
export type SinalDeHandoff = {
  destinoId: string;
  destinoKey: string;
  destinoNome: string;
  motivo?: string;
  resumo?: string;
  /** O que o cliente vai ler. Obrigatório: a passagem nunca é silenciosa. */
  aviso: string;
};

/** Efeitos que uma tool comunica para fora do turno. */
export type SinaisDoTurno = {
  handoff?: SinalDeHandoff;
};

export type ToolContext = {
  provider: IntegrationProvider;
  /** Config não-sensível já validada pelo `configSchema` da integração. */
  config: Record<string, unknown>;
  /** Segredo já decifrado. `null` quando a integração não exige credencial. */
  credential: string | null;
  agentId: string;
  conversationId?: string;
  /** Id da conversa no Chatwoot, quando a execução veio de um atendimento. */
  chatwootConversationId?: number;
  /** Objeto compartilhado do turno: a tool escreve, o worker lê depois. */
  sinais?: SinaisDoTurno;
};

export type ToolDefinition<TInput = unknown> = {
  /** Prefixado pelo provider, ex.: `clickup_criar_tarefa`. */
  name: string;
  /** É este texto que o modelo lê para decidir usar a tool. Seja prescritivo. */
  description: string;
  /**
   * Agrupa a tool na tela do agente ("Tarefas", "Comentários"...). Serve só
   * para a interface — a ordem que vai para a API continua sendo por nome.
   */
  categoria?: string;
  inputSchema: z.ZodType<TInput>;
  /**
   * Ações que escrevem em sistema externo (criar tarefa, alterar cadastro).
   * O runner registra e — na Fase 2 — pede confirmação humana antes de executar.
   */
  requiresConfirmation?: boolean;
  execute: (input: TInput, ctx: ToolContext) => Promise<unknown>;
};

export type ResultadoTeste = {
  ok: boolean;
  mensagem: string;
};

export type IntegrationDefinition = {
  provider: IntegrationProvider;
  label: string;
  descricao: string;
  /** Campos não-sensíveis do formulário (baseUrl, accountId...). */
  configSchema: z.ZodType;
  /**
   * Segredo único da integração (token/api key). `null` quando não há.
   * Guardado cifrado em `IntegrationCredential`.
   */
  credentialLabel: string | null;
  testarConexao: (ctx: ToolContext) => Promise<ResultadoTeste>;
  tools: ToolDefinition[];
};
