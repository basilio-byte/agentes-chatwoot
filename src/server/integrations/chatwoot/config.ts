import { z } from "zod";

/** Configuração não-sensível da instância — compartilhada por todos os agentes. */
export const chatwootConfigSchema = z.object({
  baseUrl: z
    .string()
    .min(1, "Informe a URL da instância")
    .transform((v) => v.replace(/\/+$/, "")) // sem barra no fim
    .refine((v) => /^https?:\/\//.test(v), "A URL precisa começar com http(s)://"),
  accountId: z.coerce
    .number()
    .int()
    .positive("O id da conta é o número que aparece na URL do Chatwoot"),
});

export type ChatwootConfig = z.infer<typeof chatwootConfigSchema>;

/** Segredos do bot de um agente, guardados cifrados num blob só. */
export const chatwootSegredosSchema = z.object({
  /** `api_access_token` do Agent Bot. */
  token: z.string().min(10, "Token muito curto"),
  /** Secret de assinatura do webhook, mostrado ao criar o bot. */
  webhookSecret: z.string().optional().default(""),
});

export type ChatwootSegredos = z.infer<typeof chatwootSegredosSchema>;
