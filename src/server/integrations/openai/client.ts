import OpenAI, { toFile } from "openai";
import { BASE_URL_PADRAO, type OpenAIConfig } from "./config";

/**
 * Cliente da OpenAI de verdade — não da OpenRouter.
 *
 * O projeto fala com a OpenRouter para conversar (`src/server/agents/`); aqui é
 * a OpenAI direta, porque é dela o endpoint de transcrição. São dois clientes do
 * mesmo SDK apontando para hosts diferentes, e trocar um pelo outro é erro
 * silencioso: a OpenRouter não tem `/audio/transcriptions`.
 */

/** Timeouts separados: transcrever um áudio longo demora mais que ver uma foto. */
export const TIMEOUT_DOWNLOAD_MS = 30_000;
export const TIMEOUT_MODELO_MS = 120_000;

/**
 * Teto de saída da descrição.
 *
 * O texto derivado entra no contexto de TODOS os turnos seguintes da conversa —
 * o histórico é relido inteiro a cada mensagem. Uma descrição de mil tokens sai
 * cara para sempre, não só uma vez.
 */
export const MAX_TOKENS_DESCRICAO = 900;

export function criarClienteOpenAI(config: OpenAIConfig, apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: config.baseUrl || BASE_URL_PADRAO,
    timeout: TIMEOUT_MODELO_MS,
    // O SDK tenta de novo sozinho em 429/5xx. Duas é o suficiente: acima disso
    // o turno demora mais do que o cliente espera, e quem cuida da persistência
    // é o cache — a próxima mensagem tenta de novo de graça.
    maxRetries: 2,
  });
}

export type ArquivoBaixado = {
  bytes: Buffer;
  mimeType: string;
  tamanhoBytes: number;
};

export class MidiaGrandeDemaisError extends Error {
  constructor(readonly limiteMb: number) {
    super(
      `Arquivo maior que o limite de ${limiteMb} MB configurado para leitura de mídia.`,
    );
    this.name = "MidiaGrandeDemaisError";
  }
}

/**
 * Baixa o anexo respeitando um teto de tamanho.
 *
 * Lê em pedaços e aborta ao estourar, em vez de `arrayBuffer()` direto: o
 * `content-length` é opcional e mentiroso em servidor com compressão, e um
 * arquivo de 2 GB derrubaria o worker inteiro — que atende quatro conversas ao
 * mesmo tempo.
 *
 * ⚠ O token do Chatwoot só é enviado quando a URL é da PRÓPRIA instância. O
 * `data_url` vem de dentro de um payload, e mandar a credencial de atendimento
 * para um host arbitrário porque ele apareceu num JSON é vazamento de segredo.
 */
export async function baixarArquivo(
  url: string,
  opcoes: {
    limiteMb: number;
    /** Instância do Chatwoot. Só para ela o token é enviado. */
    origemConfiavel?: string | null;
    token?: string | null;
  },
): Promise<ArquivoBaixado> {
  const limiteBytes = opcoes.limiteMb * 1024 * 1024;

  const resposta = await fetch(url, {
    headers: mesmaOrigem(url, opcoes.origemConfiavel) && opcoes.token
      ? { api_access_token: opcoes.token }
      : {},
    signal: AbortSignal.timeout(TIMEOUT_DOWNLOAD_MS),
  });

  if (!resposta.ok) {
    throw new Error(
      `Não consegui baixar o anexo (HTTP ${resposta.status}). Confira se a URL do Chatwoot é alcançável a partir do worker.`,
    );
  }

  const declarado = Number(resposta.headers.get("content-length") ?? "0");
  if (declarado > limiteBytes) {
    throw new MidiaGrandeDemaisError(opcoes.limiteMb);
  }

  const mimeType =
    (resposta.headers.get("content-type") ?? "").split(";")[0].trim() ||
    "application/octet-stream";

  const pedacos: Uint8Array[] = [];
  let total = 0;

  if (!resposta.body) {
    const bytes = Buffer.from(await resposta.arrayBuffer());
    if (bytes.length > limiteBytes) throw new MidiaGrandeDemaisError(opcoes.limiteMb);
    return { bytes, mimeType, tamanhoBytes: bytes.length };
  }

  const leitor = resposta.body.getReader();
  try {
    while (true) {
      const { done, value } = await leitor.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > limiteBytes) {
        // Cancela a leitura: sem isso o download continuaria até o fim mesmo
        // depois de já sabermos que o arquivo não serve.
        await leitor.cancel().catch(() => {});
        throw new MidiaGrandeDemaisError(opcoes.limiteMb);
      }
      pedacos.push(value);
    }
  } finally {
    leitor.releaseLock?.();
  }

  const bytes = Buffer.concat(pedacos);
  return { bytes, mimeType, tamanhoBytes: bytes.length };
}

/** A URL aponta para a mesma origem da instância confiável? */
export function mesmaOrigem(url: string, origem?: string | null): boolean {
  if (!origem) return false;
  try {
    return new URL(url).origin === new URL(origem).origin;
  } catch {
    return false;
  }
}

export type ResultadoDeLeitura = {
  texto: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  segundosDeAudio?: number;
};

/** Transcrição de áudio. Endpoint próprio, multipart — o SDK monta o corpo. */
export async function transcreverAudio(args: {
  cliente: OpenAI;
  arquivo: ArquivoBaixado;
  nome: string;
  model: string;
  idioma: string;
}): Promise<ResultadoDeLeitura> {
  const retorno = await args.cliente.audio.transcriptions.create({
    file: await toFile(args.arquivo.bytes, args.nome || "audio", {
      type: args.arquivo.mimeType,
    }),
    model: args.model,
    // Dica de idioma: melhora acurácia e latência em áudio curto e ruidoso,
    // que é exatamente o áudio de WhatsApp.
    ...(args.idioma ? { language: args.idioma } : {}),
  });

  const uso = retorno.usage as
    | { type?: string; input_tokens?: number; output_tokens?: number; seconds?: number }
    | undefined;

  return {
    texto: (retorno.text ?? "").trim(),
    model: args.model,
    inputTokens: uso?.input_tokens ?? 0,
    outputTokens: uso?.output_tokens ?? 0,
    // Transcrição é cobrada por duração em alguns modelos e por token em
    // outros. Guardamos os dois: a conta real depende do modelo escolhido.
    segundosDeAudio:
      typeof uso?.seconds === "number" ? Math.round(uso.seconds) : undefined,
  };
}

/**
 * Descrição de imagem.
 *
 * O arquivo vai como data URI, e não como link: a instância do Chatwoot pode
 * estar em rede privada ou atrás de autenticação, e a OpenAI não conseguiria
 * buscar a URL. Também evita expor o endereço interno para fora.
 */
export async function descreverImagem(args: {
  cliente: OpenAI;
  arquivo: ArquivoBaixado;
  model: string;
  instrucao: string;
}): Promise<ResultadoDeLeitura> {
  const dataUri = `data:${args.arquivo.mimeType};base64,${args.arquivo.bytes.toString("base64")}`;

  const retorno = await args.cliente.chat.completions.create({
    model: args.model,
    max_completion_tokens: MAX_TOKENS_DESCRICAO,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: args.instrucao },
          { type: "image_url", image_url: { url: dataUri } },
        ],
      },
    ],
  });

  return {
    texto: (retorno.choices?.[0]?.message?.content ?? "").trim(),
    model: args.model,
    inputTokens: retorno.usage?.prompt_tokens ?? 0,
    outputTokens: retorno.usage?.completion_tokens ?? 0,
  };
}

/** Leitura de documento (PDF) pelo bloco `file` do protocolo de chat. */
export async function lerDocumento(args: {
  cliente: OpenAI;
  arquivo: ArquivoBaixado;
  nome: string;
  model: string;
  instrucao: string;
}): Promise<ResultadoDeLeitura> {
  const dataUri = `data:${args.arquivo.mimeType};base64,${args.arquivo.bytes.toString("base64")}`;

  const retorno = await args.cliente.chat.completions.create({
    model: args.model,
    max_completion_tokens: MAX_TOKENS_DESCRICAO,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: args.instrucao },
          {
            type: "file",
            file: { filename: args.nome || "documento.pdf", file_data: dataUri },
          },
        ],
      },
    ],
  });

  return {
    texto: (retorno.choices?.[0]?.message?.content ?? "").trim(),
    model: args.model,
    inputTokens: retorno.usage?.prompt_tokens ?? 0,
    outputTokens: retorno.usage?.completion_tokens ?? 0,
  };
}

/**
 * Modelos da conta, para o painel conferir se o id configurado existe.
 *
 * É o único jeito honesto de validar um modelo: a OpenAI não publica catálogo
 * com capacidade (quem lê imagem, quem transcreve), então o que dá para afirmar
 * é "este id existe nesta conta".
 */
export async function listarModelosDaConta(cliente: OpenAI): Promise<string[]> {
  const pagina = await cliente.models.list();
  return pagina.data.map((m) => m.id).sort((a, b) => a.localeCompare(b));
}
