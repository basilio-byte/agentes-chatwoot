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

/**
 * Os dois ambientes da ZapSign. São hosts diferentes, com contas e tokens
 * diferentes — token de um não funciona no outro.
 *
 * ⚠ **Sandbox não tem validade jurídica.** Documento assinado lá não vale como
 * contrato. Serve para validar o fluxo; assinar cliente de verdade, nunca.
 */
export const AMBIENTES = {
  producao: "https://api.zapsign.com.br/api/v1",
  sandbox: "https://sandbox.api.zapsign.com.br/api/v1",
} as const;

export type Ambiente = keyof typeof AMBIENTES;

export const zapsignConfigSchema = z.object({
  /**
   * Ambiente, em vez da URL crua.
   *
   * Era um campo de texto e custou caro: a URL certa tem host próprio e termina
   * em `/api/v1`, e errar qualquer parte devolve 401 — que se parece com token
   * errado e manda o operador trocar a credencial certa.
   */
  ambiente: z.enum(["producao", "sandbox"]).default("producao"),

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

/** URL da API para o ambiente escolhido. */
export function urlDaApi(config: Pick<ZapSignConfig, "ambiente">) {
  return AMBIENTES[config.ambiente] ?? AMBIENTES.producao;
}

/**
 * Lê a config guardada, aceitando o formato antigo de `baseUrl` livre.
 *
 * A primeira versão pedia a URL na mão. Quem já tinha salvo apontando para o
 * sandbox não pode voltar para produção em silêncio — assinar em produção
 * achando que está testando é o erro caro nesta integração.
 */
export function lerConfigZapSign(bruto: unknown) {
  const cru = (bruto ?? {}) as Record<string, unknown>;
  const urlAntiga = typeof cru.baseUrl === "string" ? cru.baseUrl : "";

  return zapsignConfigSchema.safeParse({
    ...cru,
    ambiente:
      cru.ambiente ?? (urlAntiga.includes("sandbox") ? "sandbox" : undefined),
  });
}

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
