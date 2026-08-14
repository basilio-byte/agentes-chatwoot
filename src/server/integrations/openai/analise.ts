import type OpenAI from "openai";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { MediaKind, MediaStatus } from "@/generated/prisma/enums";
import { ehTextoPuro, tipoLigado, type Anexo } from "./classificar";
import { cortar } from "./formato";
import { modeloDeDocumento, type OpenAIConfig } from "./config";
import {
  baixarArquivo,
  descreverImagem,
  lerDocumento,
  MidiaGrandeDemaisError,
  transcreverAudio,
  type ResultadoDeLeitura,
} from "./client";

/**
 * Leitura de um anexo, com cache.
 *
 * O cache não é otimização: sem ele, o mesmo áudio é transcrito de novo a cada
 * mensagem seguinte da conversa, porque o worker relê o histórico inteiro do
 * Chatwoot em todo turno. A conta cresceria com o tamanho da conversa em vez de
 * com a quantidade de mídia.
 */

/**
 * Quantas vezes tentar de novo um anexo que falhou.
 *
 * Falha de rede ou 429 merece nova tentativa — a próxima mensagem do cliente já
 * refaz o turno. Mas sem teto, um arquivo corrompido seria reprocessado a cada
 * turno para sempre, pagando toda vez. Estourado o teto, vira `SKIPPED` e o
 * agente recebe o texto dizendo que não deu para ler.
 */
export const MAX_TENTATIVAS = 3;

export type ContextoDaAnalise = {
  cliente: OpenAI;
  config: OpenAIConfig;
  /** Instância do Chatwoot: só para ela o token de download é enviado. */
  chatwootBaseUrl?: string | null;
  chatwootToken?: string | null;
  agentId?: string | null;
  conversationId?: string | null;
  chatwootMessageId?: number | null;
};

export type Analise = {
  chave: string;
  kind: MediaKind;
  status: MediaStatus;
  texto: string | null;
  erro: string | null;
  /** Veio do cache — não custou nada neste turno. */
  doCache: boolean;
};

/**
 * Lê um anexo, reaproveitando o que já foi lido.
 *
 * Nunca lança: a falha vira texto para o agente. Um anexo ilegível não pode
 * derrubar o turno — o cliente ficaria sem resposta por causa de um `.heic`.
 */
export async function analisarAnexo(
  anexo: Anexo,
  ctx: ContextoDaAnalise,
): Promise<Analise> {
  const existente = await db.mediaAnalysis
    .findUnique({ where: { chave: anexo.chave } })
    .catch(() => null);

  if (existente && !valeTentarDeNovo(existente)) {
    return {
      chave: anexo.chave,
      kind: existente.kind,
      status: existente.status,
      texto: existente.texto,
      erro: existente.erro,
      doCache: true,
    };
  }

  const tentativasAnteriores = existente?.tentativas ?? 0;

  // Sem arquivo para ler: vídeo, localização, contato, formato sem leitor.
  // Vira registro definitivo — tentar de novo não mudaria nada.
  if (anexo.kind === MediaKind.UNSUPPORTED) {
    return gravar(anexo, ctx, {
      status: MediaStatus.SKIPPED,
      texto: anexo.motivo ?? "anexo em formato que o sistema não lê",
      erro: null,
      tentativas: tentativasAnteriores,
    });
  }

  if (!tipoLigado(anexo.kind, ctx.config)) {
    // Desligado na configuração não é falha e não fica no cache: religar a
    // opção tem de voltar a ler sem ninguém precisar limpar tabela.
    return {
      chave: anexo.chave,
      kind: anexo.kind,
      status: MediaStatus.SKIPPED,
      texto: `este tipo de anexo não está sendo lido (${anexo.nome || anexo.kind})`,
      erro: null,
      doCache: false,
    };
  }

  const comeco = Date.now();

  try {
    const arquivo = await baixarArquivo(anexo.url, {
      limiteMb: ctx.config.tamanhoMaximoMb,
      origemConfiavel: ctx.chatwootBaseUrl,
      token: ctx.chatwootToken,
    });

    const leitura = await executarLeitura(anexo, arquivo, ctx);
    const texto = cortar(leitura.texto);

    if (!texto) {
      // Áudio mudo, imagem em branco: leitura tecnicamente bem-sucedida e vazia.
      // Definitivo — repetir daria o mesmo nada, pago de novo.
      return gravar(anexo, ctx, {
        status: MediaStatus.SKIPPED,
        texto: "o anexo foi lido, mas não havia conteúdo legível nele",
        erro: null,
        tentativas: tentativasAnteriores,
        model: leitura.model,
        duracaoMs: Date.now() - comeco,
        tamanhoBytes: arquivo.tamanhoBytes,
        mimeType: arquivo.mimeType,
      });
    }

    return gravar(anexo, ctx, {
      status: MediaStatus.OK,
      texto,
      erro: null,
      tentativas: tentativasAnteriores,
      model: leitura.model,
      inputTokens: leitura.inputTokens,
      outputTokens: leitura.outputTokens,
      segundosDeAudio: leitura.segundosDeAudio,
      duracaoMs: Date.now() - comeco,
      tamanhoBytes: arquivo.tamanhoBytes,
      mimeType: arquivo.mimeType,
    });
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : String(erro);
    const tentativas = tentativasAnteriores + 1;
    const definitivo = !valeInsistir(erro) || tentativas >= MAX_TENTATIVAS;

    logger.warn(
      {
        chave: anexo.chave,
        kind: anexo.kind,
        tentativas,
        definitivo,
        erro: motivo,
      },
      "falha ao ler anexo",
    );

    return gravar(anexo, ctx, {
      status: definitivo ? MediaStatus.SKIPPED : MediaStatus.ERROR,
      // O agente precisa saber que chegou algo e que não deu para ler — senão
      // responde como se a mensagem estivesse vazia.
      texto: definitivo
        ? `não consegui ler este anexo (${resumirFalha(erro)})`
        : null,
      erro: motivo.slice(0, 500),
      tentativas,
      duracaoMs: Date.now() - comeco,
    });
  }
}

async function executarLeitura(
  anexo: Anexo,
  arquivo: { bytes: Buffer; mimeType: string; tamanhoBytes: number },
  ctx: ContextoDaAnalise,
): Promise<ResultadoDeLeitura> {
  if (anexo.kind === MediaKind.AUDIO) {
    return transcreverAudio({
      cliente: ctx.cliente,
      arquivo,
      nome: anexo.nome,
      model: ctx.config.modeloAudio,
      idioma: ctx.config.idiomaAudio,
    });
  }

  if (anexo.kind === MediaKind.IMAGE) {
    return descreverImagem({
      cliente: ctx.cliente,
      arquivo,
      model: ctx.config.modeloVisao,
      instrucao: ctx.config.instrucaoImagem,
    });
  }

  // Texto puro é o próprio conteúdo: nenhum modelo é chamado, e portanto nada é
  // cobrado. Um `.txt` de 3 KB não precisa de leitura assistida.
  if (ehTextoPuro(anexo)) {
    return {
      texto: arquivo.bytes.toString("utf8"),
      model: "leitura-direta",
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  return lerDocumento({
    cliente: ctx.cliente,
    arquivo,
    nome: anexo.nome,
    model: modeloDeDocumento(ctx.config),
    instrucao: ctx.config.instrucaoDocumento,
  });
}

/** Só `ERROR` volta para a fila. `OK` e `SKIPPED` são definitivos. */
function valeTentarDeNovo(registro: {
  status: MediaStatus;
  tentativas: number;
}): boolean {
  return (
    registro.status === MediaStatus.ERROR && registro.tentativas < MAX_TENTATIVAS
  );
}

/**
 * A falha é do tipo que uma nova tentativa resolve?
 *
 * Arquivo grande demais, formato recusado e 4xx não melhoram com insistência —
 * insistir só gastaria de novo. Rede, timeout, 429 e 5xx melhoram.
 */
function valeInsistir(erro: unknown): boolean {
  if (erro instanceof MidiaGrandeDemaisError) return false;

  const status = (erro as { status?: number } | null)?.status;
  if (typeof status === "number") {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  return true;
}

function resumirFalha(erro: unknown): string {
  if (erro instanceof MidiaGrandeDemaisError) return "arquivo grande demais";

  const status = (erro as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return "credencial da OpenAI recusada";
  if (status === 404) return "modelo configurado não existe nesta conta";
  if (status === 429) return "limite de uso da OpenAI atingido";
  if (typeof status === "number" && status >= 500) return "OpenAI instável";

  const mensagem = erro instanceof Error ? erro.message : String(erro);
  return mensagem.slice(0, 120);
}

type Gravacao = {
  status: MediaStatus;
  texto: string | null;
  erro: string | null;
  tentativas: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  segundosDeAudio?: number;
  duracaoMs?: number;
  tamanhoBytes?: number;
  mimeType?: string;
};

/**
 * Persiste o resultado. Melhor esforço: se o banco recusar, o turno segue com o
 * texto em mãos — perder o cache é caro, perder a resposta ao cliente é pior.
 */
async function gravar(
  anexo: Anexo,
  ctx: ContextoDaAnalise,
  dados: Gravacao,
): Promise<Analise> {
  const comum = {
    kind: anexo.kind,
    status: dados.status,
    nomeArquivo: anexo.nome || null,
    mimeType: dados.mimeType ?? null,
    tamanhoBytes: dados.tamanhoBytes ?? anexo.tamanhoBytes ?? null,
    texto: dados.texto,
    erro: dados.erro,
    tentativas: dados.tentativas,
    model: dados.model ?? null,
    inputTokens: dados.inputTokens ?? 0,
    outputTokens: dados.outputTokens ?? 0,
    segundosDeAudio: dados.segundosDeAudio ?? null,
    duracaoMs: dados.duracaoMs ?? null,
    agentId: ctx.agentId ?? null,
    conversationId: ctx.conversationId ?? null,
    chatwootMessageId: ctx.chatwootMessageId ?? null,
  };

  try {
    await db.mediaAnalysis.upsert({
      where: { chave: anexo.chave },
      update: comum,
      create: { chave: anexo.chave, ...comum },
    });
  } catch (erro) {
    logger.warn(
      { chave: anexo.chave, erro },
      "não consegui gravar a leitura do anexo — o turno segue sem cache",
    );
  }

  return {
    chave: anexo.chave,
    kind: anexo.kind,
    status: dados.status,
    texto: dados.texto,
    erro: dados.erro,
    doCache: false,
  };
}
