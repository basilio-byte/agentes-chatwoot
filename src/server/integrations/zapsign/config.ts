import { z } from "zod";

/** Modos de autenticação do signatário aceitos pela ZapSign. */
export const AUTH_MODES = [
  "assinaturaTela",
  "tokenEmail",
  "assinaturaTela-tokenEmail",
  "tokenSms",
  "assinaturaTela-tokenSms",
  "tokenWhatsapp",
  "assinaturaTela-tokenWhatsapp",
  "certificadoDigital",
] as const;

export type AuthMode = (typeof AUTH_MODES)[number];

export const zapsignConfigSchema = z.object({
  /**
   * Base da API. Produção é `https://api.zapsign.com.br/api/v1`; a ZapSign tem
   * ambiente de testes com host próprio, e é por isso que isto é configurável.
   */
  baseUrl: z
    .string()
    .default("https://api.zapsign.com.br/api/v1")
    .refine((v) => v.startsWith("http"), "A URL precisa começar com http"),

  /**
   * Modelos DOCX por nome — "Contrato de Endereço Fiscal" em vez do token cru.
   *
   * Mesmo motivo das listas nomeadas do ClickUp: id no prompt é frágil (muda se
   * o modelo for recriado), ilegível na revisão, e obriga o agente a gastar uma
   * chamada de descoberta.
   */
  modelos: z
    .array(z.object({ nome: z.string().min(1), templateId: z.string().min(1) }))
    .default([]),

  /** Como o signatário se autentica quando o fluxo não disser outra coisa. */
  authModePadrao: z.enum(AUTH_MODES).default("assinaturaTela-tokenEmail"),

  /**
   * Manda o link de assinatura por WhatsApp automaticamente.
   *
   * ⚠ A ZapSign cobra por envio (R$ 0,50 na tabela de 07/2026). Fica desligado
   * por padrão para ninguém descobrir o custo pela fatura.
   */
  whatsappAutomatico: z.boolean().default(false),

  lang: z.enum(["pt-br", "es", "en"]).default("pt-br"),
});

export type ZapSignConfig = z.infer<typeof zapsignConfigSchema>;

export const zapsignSegredoSchema = z.object({
  apiToken: z.string().min(10, "Token muito curto"),
});

/** Acha o modelo pelo nome cadastrado, ou aceita o id cru. */
export function resolverModelo(
  termo: string | undefined,
  config: ZapSignConfig,
): { templateId?: string; nomes: string[] } {
  const nomes = config.modelos.map((m) => m.nome);
  if (!termo) return { nomes };

  const alvo = termo.trim().toLowerCase();
  const achado = config.modelos.find((m) => m.nome.trim().toLowerCase() === alvo);
  if (achado) return { templateId: achado.templateId, nomes };

  // Token de modelo é um uuid; se veio com cara de id, deixa passar.
  return { templateId: termo.includes("-") ? termo : undefined, nomes };
}

/**
 * Status do signatário, normalizado.
 *
 * A ZapSign responde valores **diferentes** conforme o endpoint: o detalhe do
 * documento devolve `new` / `link-opened` / `signed`, e a listagem devolve
 * `nao_abriu` / `abriu` / `assinou` / `recusou` / `expirou` / `cancelado`.
 * Quem consumir os dois sem normalizar compara maçã com laranja e conclui que
 * ninguém assinou.
 */
export function normalizarStatusDeSignatario(bruto: string | undefined | null) {
  switch ((bruto ?? "").toLowerCase()) {
    case "signed":
    case "assinou":
      return "assinou" as const;
    case "link-opened":
    case "abriu":
      return "abriu" as const;
    case "refused":
    case "recusou":
      return "recusou" as const;
    case "expirou":
      return "expirou" as const;
    case "cancelado":
      return "cancelado" as const;
    case "new":
    case "nao_abriu":
      return "nao_abriu" as const;
    default:
      return "desconhecido" as const;
  }
}
