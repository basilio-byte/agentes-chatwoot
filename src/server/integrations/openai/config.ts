import { z } from "zod";

/**
 * Configuração da leitura de mídia.
 *
 * Os modelos são campo de texto, e não uma lista fixa no código: a OpenAI lança
 * modelo novo mais rápido do que este repositório recebe deploy, e uma lista
 * fechada obrigaria a mexer em código para usar o que já existe na conta. Quem
 * confere se o id existe é o botão de testar, contra `GET /models` ao vivo.
 */

/** Endpoint padrão. Aqui é a OpenAI de verdade — não a OpenRouter. */
export const BASE_URL_PADRAO = "https://api.openai.com/v1";

export const MODELO_VISAO_PADRAO = "gpt-4o-mini";
export const MODELO_AUDIO_PADRAO = "gpt-4o-mini-transcribe";

/**
 * O que pedir ao modelo ao olhar uma imagem.
 *
 * Prescritivo de propósito: a saída disto entra na mensagem do cliente, e o
 * agente vai decidir o atendimento a partir dela. "Descreva a imagem" devolve
 * literatura; o que serve é o dado que estava na foto.
 */
export const INSTRUCAO_IMAGEM_PADRAO =
  "Descreva esta imagem para um atendente que não pode vê-la. Seja objetivo e " +
  "curto. Transcreva TODO texto legível (valores, datas, nomes, números de " +
  "documento, códigos). Se for comprovante, recibo ou print de pagamento, " +
  "diga o valor, a data e para quem foi. Se algo estiver ilegível, diga que " +
  "está ilegível em vez de adivinhar.";

export const INSTRUCAO_DOCUMENTO_PADRAO =
  "Resuma este documento para um atendente que não pode abri-lo. Diga o tipo " +
  "de documento e liste os dados que importam para atendimento: nomes, CPF/CNPJ, " +
  "datas, valores, prazos e o que está sendo pedido ou assinado. Não invente " +
  "nada que não esteja no arquivo.";

/**
 * Teto de download por anexo.
 *
 * 20 MB porque é o limite prático dos endpoints da OpenAI (25 MB no áudio) e
 * porque o arquivo inteiro passa pela memória do worker, que atende 4 conversas
 * em paralelo.
 */
export const TAMANHO_MAXIMO_MB_PADRAO = 20;

/**
 * Anexos processados por turno.
 *
 * Não é o total da conversa: o que já foi lido vem do cache e não conta. O teto
 * existe para que um cliente que despeja trinta fotos de uma vez não vire trinta
 * chamadas pagas no mesmo turno. O que passar do teto entra no contexto como
 * "não lido", e o turno seguinte pega os próximos.
 */
export const MAX_ANEXOS_POR_TURNO_PADRAO = 8;

export const openaiConfigSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .default(BASE_URL_PADRAO)
    .transform((v) => (v || BASE_URL_PADRAO).replace(/\/+$/, ""))
    .refine((v) => /^https?:\/\//.test(v), "A URL precisa começar com http(s)://"),

  modeloVisao: z
    .string()
    .trim()
    .min(1, "Informe o modelo que lê imagem")
    .default(MODELO_VISAO_PADRAO),

  modeloAudio: z
    .string()
    .trim()
    .min(1, "Informe o modelo que transcreve áudio")
    .default(MODELO_AUDIO_PADRAO),

  /** Vazio = usa o mesmo modelo da imagem. */
  modeloDocumento: z.string().trim().default(""),

  /**
   * ISO-639-1 do áudio esperado. A API usa como dica: melhora a acurácia e a
   * latência. Vazio deixa o modelo detectar — o que erra com áudio curto e
   * ruidoso, que é justamente o áudio de WhatsApp.
   */
  idiomaAudio: z
    .string()
    .trim()
    .max(5)
    .default("pt")
    .refine(
      (v) => v === "" || /^[a-z]{2}(-[a-zA-Z]{2})?$/.test(v),
      "Use o código de duas letras do idioma (pt, en, es) ou deixe em branco",
    ),

  lerImagem: z.boolean().default(true),
  lerAudio: z.boolean().default(true),
  lerDocumento: z.boolean().default(true),

  instrucaoImagem: z.string().trim().default(INSTRUCAO_IMAGEM_PADRAO),
  instrucaoDocumento: z.string().trim().default(INSTRUCAO_DOCUMENTO_PADRAO),

  tamanhoMaximoMb: z.coerce
    .number()
    .int()
    .min(1)
    .max(25, "A OpenAI recusa arquivo acima de 25 MB")
    .default(TAMANHO_MAXIMO_MB_PADRAO),

  maxAnexosPorTurno: z.coerce
    .number()
    .int()
    .min(1)
    .max(30)
    .default(MAX_ANEXOS_POR_TURNO_PADRAO),
});

export type OpenAIConfig = z.output<typeof openaiConfigSchema>;

/**
 * Lê a config guardada, sempre com defaults.
 *
 * Nunca falha: config pela metade tem de continuar lendo mídia. Transformar
 * campo esquecido em silêncio no atendimento é o pior desfecho possível — mesma
 * regra de `atendeInbox`.
 */
export function lerConfigOpenAI(bruto: unknown): OpenAIConfig {
  const parsed = openaiConfigSchema.safeParse(bruto ?? {});
  if (parsed.success) return parsed.data;
  return openaiConfigSchema.parse({});
}

/** O modelo que lê documento cai para o de imagem quando não foi escolhido. */
export function modeloDeDocumento(config: OpenAIConfig): string {
  return config.modeloDocumento || config.modeloVisao;
}
