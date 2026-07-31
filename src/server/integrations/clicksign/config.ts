import { z } from "zod";

/**
 * Critérios de autenticação aceitos no requisito do signatário.
 * A lista vem da documentação da API v3 (`POST /envelopes/:id/requirements`).
 */
export const AUTENTICACOES = [
  "email",
  "sms",
  "whatsapp",
  "pix",
  "icp_brasil",
  "handwritten",
  "selfie",
  "official_document",
  "address_proof",
  "liveness",
  "facial_biometrics",
  "identity_biometrics",
  "auto_signature",
  "presential",
  "embedded_signature",
  "biometric",
  "documentscopy",
] as const;

export type Autenticacao = (typeof AUTENTICACOES)[number];

/** Papel do signatário no documento (`role` do requisito de qualificação). */
export const PAPEIS = ["sign", "party", "contractor"] as const;
export type Papel = (typeof PAPEIS)[number];

export const clicksignConfigSchema = z.object({
  /**
   * Base da API, **sem padrão de propósito**.
   *
   * A documentação pública só publica o host de sandbox
   * (`https://sandbox.clicksign.com/api/v3`); o de produção é informado pelo
   * gerente de conta junto com o Access Token. Chutar aqui seria mandar contrato
   * de cliente para o ambiente errado — ou para lugar nenhum.
   */
  baseUrl: z
    .string()
    .min(1, "Informe a URL da API (o gerente de conta informa a de produção)")
    .refine((v) => v.startsWith("http"), "A URL precisa começar com http"),

  /** Autenticação exigida do signatário quando o fluxo não disser outra coisa. */
  autenticacaoPadrao: z.enum(AUTENTICACOES).default("email"),

  locale: z.enum(["pt-BR", "en-US"]).default("pt-BR"),

  /** Prazo padrão, em dias, para assinar. Vira `deadline_at` no envelope. */
  prazoEmDias: z.number().int().min(1).max(90).default(15),

  /** Fecha o envelope sozinho quando todo mundo assina. */
  fecharAutomaticamente: z.boolean().default(true),
});

export type ClickSignConfig = z.infer<typeof clicksignConfigSchema>;

export const clicksignSegredoSchema = z.object({
  accessToken: z.string().min(10, "Token muito curto"),
});

/**
 * Envelope do JSON:API.
 *
 * A ClickSign não aceita o objeto cru: tudo vai dentro de
 * `{ data: { type, attributes } }`, com `relationships` à parte. Montar isso na
 * mão em cada chamada é como se esquece um `type` e se ganha um 400 opaco.
 */
export function corpoJsonApi(
  type: string,
  attributes: Record<string, unknown>,
  relationships?: Record<string, { type: string; id: string }>,
) {
  const relacoes = Object.entries(relationships ?? {}).reduce<
    Record<string, { data: { type: string; id: string } }>
  >((acc, [nome, valor]) => {
    acc[nome] = { data: valor };
    return acc;
  }, {});

  return {
    data: {
      type,
      attributes,
      ...(Object.keys(relacoes).length ? { relationships: relacoes } : {}),
    },
  };
}

/**
 * Prazo de assinatura em RFC 3339, a partir de hoje.
 *
 * Recebe a referência por parâmetro para o teste não depender do relógio.
 */
export function prazoDeAssinatura(dias: number, referencia = new Date()) {
  const limite = new Date(referencia.getTime() + dias * 24 * 60 * 60 * 1000);
  return limite.toISOString();
}
