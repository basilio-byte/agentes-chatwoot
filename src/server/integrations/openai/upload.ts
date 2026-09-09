import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { MediaKind, MediaStatus } from "@/generated/prisma/enums";
import {
  EXTENSOES_DE_AUDIO,
  EXTENSOES_DE_IMAGEM,
  EXTENSOES_DE_PDF,
  EXTENSOES_DE_TEXTO,
  mimeDaExtensao,
  tipoLigado,
} from "./classificar";
import { cortar } from "./formato";
import { modeloDeDocumento, type OpenAIConfig } from "./config";
import {
  descreverImagem,
  lerDocumento,
  transcreverAudio,
  type ResultadoDeLeitura,
} from "./client";
import { resumirFalha } from "./analise";

/**
 * Arquivo que veio do NAVEGADOR vira texto — a mesa do agente.
 *
 * Existe porque `analisarAnexo` não serve aqui: ele parte de uma URL para
 * baixar e de uma chave de cache da conversa, e a mesa não tem nem uma nem
 * outra. O que ele tem e é obrigatório reusar são as decisões: a lista fechada
 * de formatos, o teto de tamanho, os toggles por tipo e o vocabulário de recusa
 * em pt-BR.
 *
 * ⚠ O toggle por tipo é a razão principal de isto ser um adaptador em vez de um
 * despacho direto ao `client.ts`. `tipoLigado` era chamado em UM lugar no
 * projeto inteiro (`analise.ts`), então um caminho novo que fosse direto fura o
 * toggle sem erro nenhum: o operador desliga "ler imagem" em Integrações, o
 * worker do Chatwoot obedece, e a mesa continua enviando — e sendo cobrada.
 */

export type ArquivoEnviado = {
  bytes: Buffer;
  /** Nome original. É dele que sai a extensão, e é ele que a tela mostra. */
  nome: string;
  /**
   * O tamanho que o navegador declarou.
   *
   * ⚠ Não é ele que decide o teto: quem decide é `bytes.length`. Número que vem
   * do cliente não é prova de nada — aceitá-lo deixaria passar um arquivo de
   * 200 MB que se diz de 1 MB. Serve só para acusar upload truncado, que de
   * outro modo chegaria como "documento ilegível" sem ninguém entender por quê.
   */
  tamanhoBytes?: number | null;
  /**
   * O tipo que o navegador declarou (`File.type`), quando houver.
   *
   * Entra em duas decisões e em nenhuma delas manda sozinho: separa vídeo de
   * áudio (ver abaixo) e completa o MIME onde a nossa tabela não tem resposta.
   *
   * ⚠ Obrigatório no tipo, e podendo ser `null`: quem escrever a rota tem de
   * DECIDIR o que mandar. Opcional, o campo seria esquecido, e a separação
   * entre vídeo e áudio — que só existe por causa dele — sumiria em silêncio.
   */
  mimeType: string | null;
  config: OpenAIConfig;
  cliente: OpenAI;
  /** Procedência do registro contábil. */
  agentId?: string | null;
};

export type LeituraDeArquivoEnviado = {
  /**
   * `mesa:<uuid>` da linha gravada em `MediaAnalysis`, ou `null` quando a
   * recusa aconteceu antes de gastar e nada foi gravado.
   */
  chave: string | null;
  kind: MediaKind;
  status: MediaStatus;
  nome: string;
  /** O texto extraído, pronto para virar a mensagem do turno. */
  texto: string | null;
  /** Por que não deu, em pt-BR, para a tela mostrar. Nulo quando deu certo. */
  motivo: string | null;
  model: string | null;
};

/**
 * Lê o arquivo enviado e devolve o texto — ou o motivo em português.
 *
 * Nunca lança, como o resto do módulo: falha de leitura vira texto para quem
 * está olhando a tela. A diferença para `analisarAnexo` é o `texto` sair NULO
 * quando não deu, em vez de trazer "não consegui ler": lá há um cliente
 * esperando e o agente precisa saber que chegou alguma coisa; aqui quem decide
 * se manda o agente rodar é a pessoa que acabou de enviar o arquivo, e pôr o
 * agente para pensar em cima de uma frase de erro é execução paga sobre nada.
 */
export async function lerArquivoEnviado(
  entrada: ArquivoEnviado,
): Promise<LeituraDeArquivoEnviado> {
  // `trim` ANTES do fallback: nome só de espaços passava direto e chegava
  // vazio na tela, porque `"   " || "arquivo"` devolve os espaços.
  const nome = entrada.nome?.trim() || "arquivo";
  const extensao = extensaoDe(nome);
  const declarado = (entrada.mimeType ?? "").toLowerCase().trim();
  const tamanhoBytes = entrada.bytes.length;

  if (
    typeof entrada.tamanhoBytes === "number" &&
    entrada.tamanhoBytes !== tamanhoBytes
  ) {
    logger.warn(
      { nome, declarado: entrada.tamanhoBytes, recebido: tamanhoBytes },
      "o upload chegou com tamanho diferente do que o navegador declarou",
    );
  }

  const kind = tipoDaExtensao(extensao);

  // Vídeo antes de áudio, pela mesma razão de `classificarAnexo`: `mp4` e
  // `webm` são extensão dos dois, e mandar um vídeo para a transcrição é caro e
  // provavelmente inútil. Aqui não existe o `file_type` do Chatwoot para
  // consultar, então quem separa é o tipo que o navegador declara.
  //
  // ⚠ Só vale onde a ambiguidade existe, isto é, quando a EXTENSÃO já resolveu
  // para áudio. Antes esta checagem vinha primeiro e valia para tudo: um
  // navegador que declarasse `video/*` para um PDF ou um PNG — e navegador de
  // celular declara o que quer — fazia recusar arquivo bom, dizendo à pessoa
  // que ela mandou um vídeo.
  if (kind === MediaKind.AUDIO && declarado.startsWith("video/")) {
    return recusa(
      MediaKind.UNSUPPORTED,
      nome,
      `não dá para ler um vídeo (${nome}) — descreva por escrito o que ele mostra`,
    );
  }

  if (!kind) {
    // ⚠ Recusa de graça. `.heic` para a visão e `.amr` para a transcrição são
    // 400 PAGO, e a lista fechada de `classificar.ts` existe exatamente para
    // isso não ser descoberto na fatura. Dizer o que chegou é o que permite à
    // pessoa converter o arquivo em vez de reenviar o mesmo.
    return recusa(
      MediaKind.UNSUPPORTED,
      nome,
      `não sei ler um arquivo ${extensao ? `.${extensao}` : "sem extensão"} (${nome}). Aceito: ${ACEITOS.join(", ")}.`,
    );
  }

  if (!tipoLigado(kind, entrada.config)) {
    // Mesmo vocabulário de `analise.ts`: quem lê a tela do agente e a tela da
    // mesa é a mesma pessoa, e duas redações para o mesmo desligamento fariam
    // parecer dois problemas diferentes.
    return recusa(
      kind,
      nome,
      `este tipo de anexo não está sendo lido (${nome || kind})`,
    );
  }

  const limiteBytes = entrada.config.tamanhoMaximoMb * 1024 * 1024;
  if (tamanhoBytes > limiteBytes) {
    return recusa(
      kind,
      nome,
      `o arquivo tem ${(tamanhoBytes / 1024 / 1024).toFixed(1)} MB e o limite configurado para leitura é ${entrada.config.tamanhoMaximoMb} MB`,
    );
  }

  const arquivo = {
    bytes: entrada.bytes,
    mimeType: mimeDoArquivo(extensao, declarado),
    tamanhoBytes,
  };

  const comeco = Date.now();

  try {
    const leitura = await executarLeitura(kind, extensao, arquivo, nome, entrada);
    const texto = cortar(leitura.texto);

    if (!texto) {
      return gravar(kind, nome, {
        status: MediaStatus.SKIPPED,
        texto: null,
        motivo: "o arquivo foi lido, mas não havia conteúdo legível nele",
        erro: null,
        model: leitura.model,
        inputTokens: leitura.inputTokens,
        outputTokens: leitura.outputTokens,
        segundosDeAudio: leitura.segundosDeAudio,
        duracaoMs: Date.now() - comeco,
        mimeType: arquivo.mimeType,
        tamanhoBytes,
        agentId: entrada.agentId,
      });
    }

    return gravar(kind, nome, {
      status: MediaStatus.OK,
      texto,
      motivo: null,
      erro: null,
      model: leitura.model,
      inputTokens: leitura.inputTokens,
      outputTokens: leitura.outputTokens,
      segundosDeAudio: leitura.segundosDeAudio,
      duracaoMs: Date.now() - comeco,
      mimeType: arquivo.mimeType,
      tamanhoBytes,
      agentId: entrada.agentId,
    });
  } catch (erro) {
    const cru = erro instanceof Error ? erro.message : String(erro);
    logger.warn({ nome, kind, erro: cru }, "falha ao ler arquivo enviado na mesa");

    // ⚠ `resumirFalha` e não a mensagem crua: erro de autenticação da OpenAI
    // chega a repetir pedaço da chave enviada, e isto aqui vai direto para a
    // tela de quem mandou o arquivo. A mensagem inteira fica na coluna `erro`,
    // atrás de sessão, que é onde já ficava.
    return gravar(kind, nome, {
      status: MediaStatus.SKIPPED,
      texto: null,
      motivo: `não consegui ler este arquivo (${resumirFalha(erro)})`,
      erro: cru.slice(0, 500),
      duracaoMs: Date.now() - comeco,
      mimeType: arquivo.mimeType,
      tamanhoBytes,
      agentId: entrada.agentId,
    });
  }
}

/**
 * Recusa antes de gastar. Não vira linha em `MediaAnalysis`.
 *
 * Aquela tabela é o registro do que foi LIDO — e cobrado. Enchê-la de recusas
 * afogaria em ruído a tela que responde "está lendo mesmo?". O rastro aqui é a
 * própria tela da mesa, com a pessoa parada na frente dela; no worker a recusa
 * acontece sem ninguém olhando, e por isso lá ela precisa ficar escrita.
 *
 * `SKIPPED` e nunca `ERROR`: `ERROR` quer dizer "volta para a fila na próxima
 * mensagem do cliente", e aqui não há fila nem próxima mensagem — quem tenta de
 * novo é a pessoa, enviando o arquivo outra vez.
 */
function recusa(
  kind: MediaKind,
  nome: string,
  motivo: string,
): LeituraDeArquivoEnviado {
  return {
    chave: null,
    kind,
    status: MediaStatus.SKIPPED,
    nome,
    texto: null,
    motivo,
    model: null,
  };
}

type Gravacao = {
  status: MediaStatus;
  texto: string | null;
  motivo: string | null;
  erro: string | null;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  segundosDeAudio?: number;
  duracaoMs?: number;
  mimeType?: string;
  tamanhoBytes?: number;
  agentId?: string | null;
};

/**
 * Grava a leitura paga em `MediaAnalysis` — e nunca a lê de volta.
 *
 * ⚠ A chave é `mesa:<uuid>`: nova a cada envio, e por isso invisível para a
 * busca de cache de `analisarAnexo`. Chavear por hash do conteúdo faria a mesa
 * cachear entre usuários, e `MediaAnalysis` não tem dono — o documento que uma
 * pessoa enviou reapareceria para outra. O cache existe para a releitura do
 * histórico do Chatwoot, que a mesa não tem.
 *
 * Grava mesmo sem poder reusar porque esta é a ÚNICA contabilidade da leitura:
 * `/consumo` só enxerga `AgentRun`, e leitura de mídia não cria `AgentRun`. Sem
 * a linha, a mesa seria o primeiro caminho pago do projeto com rastro zero.
 *
 * Melhor esforço, como em `analise.ts`: banco fora do ar não pode fazer perder
 * um texto que já foi pago.
 */
async function gravar(
  kind: MediaKind,
  nome: string,
  dados: Gravacao,
): Promise<LeituraDeArquivoEnviado> {
  const chave = `mesa:${randomUUID()}`;

  try {
    await db.mediaAnalysis.create({
      data: {
        chave,
        kind,
        status: dados.status,
        nomeArquivo: nome || null,
        mimeType: dados.mimeType ?? null,
        tamanhoBytes: dados.tamanhoBytes ?? null,
        texto: dados.texto,
        erro: dados.erro,
        tentativas: 0,
        model: dados.model ?? null,
        inputTokens: dados.inputTokens ?? 0,
        outputTokens: dados.outputTokens ?? 0,
        segundosDeAudio: dados.segundosDeAudio ?? null,
        duracaoMs: dados.duracaoMs ?? null,
        agentId: dados.agentId ?? null,
      },
    });
  } catch (erro) {
    logger.warn(
      { chave, erro },
      "não consegui gravar a leitura da mesa — o texto segue, o registro se perde",
    );
  }

  return {
    chave,
    kind,
    status: dados.status,
    nome,
    texto: dados.texto,
    motivo: dados.motivo,
    model: dados.model ?? null,
  };
}

async function executarLeitura(
  kind: MediaKind,
  extensao: string,
  arquivo: { bytes: Buffer; mimeType: string; tamanhoBytes: number },
  nome: string,
  entrada: ArquivoEnviado,
): Promise<ResultadoDeLeitura> {
  if (kind === MediaKind.AUDIO) {
    return transcreverAudio({
      cliente: entrada.cliente,
      arquivo,
      nome,
      model: entrada.config.modeloAudio,
      idioma: entrada.config.idiomaAudio,
    });
  }

  if (kind === MediaKind.IMAGE) {
    return descreverImagem({
      cliente: entrada.cliente,
      arquivo,
      model: entrada.config.modeloVisao,
      instrucao: entrada.config.instrucaoImagem,
    });
  }

  if (EXTENSOES_DE_TEXTO.includes(extensao)) {
    return {
      texto: arquivo.bytes.toString("utf8"),
      // Mesmo rótulo de `analise.ts`: a tela de leituras agrupa por modelo, e
      // dois nomes para a leitura que não chama modelo nenhum virariam dois.
      model: "leitura-direta",
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  return lerDocumento({
    cliente: entrada.cliente,
    arquivo,
    nome,
    model: modeloDeDocumento(entrada.config),
    instrucao: entrada.config.instrucaoDocumento,
  });
}

/**
 * O que este arquivo é, pelas MESMAS listas fechadas do Chatwoot.
 *
 * Reescrever as listas aqui seria capacidade duplicada — e a cópia divergiria
 * na primeira vez que a OpenAI aceitasse um formato novo, deixando a mesa
 * mandar para o endpoint o que o worker já sabe que volta 400.
 */
function tipoDaExtensao(extensao: string): MediaKind | null {
  if (EXTENSOES_DE_AUDIO.includes(extensao)) return MediaKind.AUDIO;
  if (EXTENSOES_DE_IMAGEM.includes(extensao)) return MediaKind.IMAGE;
  if (EXTENSOES_DE_PDF.includes(extensao) || EXTENSOES_DE_TEXTO.includes(extensao)) {
    return MediaKind.DOCUMENT;
  }
  return null;
}

const ACEITOS = [
  ...EXTENSOES_DE_AUDIO,
  ...EXTENSOES_DE_IMAGEM,
  ...EXTENSOES_DE_PDF,
  ...EXTENSOES_DE_TEXTO,
];

function extensaoDe(nome: string): string {
  const ponto = nome.lastIndexOf(".");
  return ponto > 0 ? nome.slice(ponto + 1).toLowerCase() : "";
}

/**
 * A lista fechada manda no MIME; o navegador só completa o que ela não sabe.
 *
 * `mimeDaExtensao` devolve `application/octet-stream` para `.mpga` e `.yaml`, e
 * mandar octet-stream para a transcrição é pedir recusa — nesse buraco o tipo
 * declarado pelo sistema operacional de quem enviou é melhor que nada.
 */
function mimeDoArquivo(extensao: string, declarado: string): string {
  const daLista = mimeDaExtensao(extensao);
  if (daLista !== "application/octet-stream") return daLista;
  return declarado || daLista;
}
