import { z } from "zod";

/**
 * Validação de variáveis de ambiente.
 *
 * A validação é **preguiçosa** de propósito: o `next build` roda dentro do Docker
 * sem as variáveis de runtime (elas só existem no Easypanel), então validar no
 * momento do import quebraria o build. Quem precisa do valor chama `env()`.
 */
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatória"),
  REDIS_URL: z.string().min(1, "REDIS_URL é obrigatória"),

  /**
   * Opcional no boot: o painel funciona sem ela (CRUD, configuração, catálogo
   * de modelos). Só o agent runner exige — e falha com mensagem clara.
   * Ver `getOpenRouter()`.
   */
  OPENROUTER_API_KEY: z.string().optional(),
  /**
   * Chave de GESTÃO, só para ler o saldo em Consumo. Opcional: a chave de
   * inferência acima costuma ser aceita em `/credits`, e é a que o fluxo do
   * n8n usava. Serve para quando ela for recusada — sem teto próprio, uma
   * chave de inferência não sabe o saldo da conta.
   * Criada em openrouter.ai/settings/management-keys.
   */
  OPENROUTER_MANAGEMENT_KEY: z.string().optional(),
  /** Atribuição no ranking público da OpenRouter. Opcionais. */
  OPENROUTER_SITE_URL: z.string().optional(),
  OPENROUTER_SITE_NAME: z.string().optional(),
  /** Sobrescreve o endpoint. Serve para testes com mock e para proxy interno. */
  OPENROUTER_BASE_URL: z.string().optional(),

  /**
   * Proxy Claude MAX (`claude-max-api-proxy`): o motor alternativo à OpenRouter,
   * pela assinatura Max. Os dois opcionais, e só valem JUNTOS — sem eles a
   * opção nem aparece no painel e todo agente roda na OpenRouter, como antes.
   * A URL é a base OpenAI do proxy, terminando em `/v1`. Ver `agents/motor.ts`.
   */
  CLAUDE_MAX_BASE_URL: z.string().optional(),
  CLAUDE_MAX_API_KEY: z.string().optional(),

  AUTH_SECRET: z.string().min(1, "AUTH_SECRET é obrigatória"),
  AUTH_TRUST_HOST: z.string().optional(),

  /** 32 bytes em base64. Trocar torna ilegíveis todas as credenciais já salvas. */
  ENCRYPTION_KEY: z.string().min(1, "ENCRYPTION_KEY é obrigatória"),

  CHATWOOT_WEBHOOK_SECRET: z.string().optional(),

  /**
   * Se definido, a tela de primeiro acesso exige este token para criar a conta
   * inicial. Sem ele, qualquer um que abrir a URL antes de você cria o OWNER.
   */
  BOOTSTRAP_TOKEN: z.string().optional(),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detalhes = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Variáveis de ambiente inválidas:\n${detalhes}\n\nConfira o .env.example.`,
    );
  }

  cached = parsed.data;
  return cached;
}
