import { logger } from "@/lib/logger";
import { criarClienteOpenAI, listarModelosDaConta } from "./client";
import type { OpenAIConfig } from "./config";

/**
 * Catálogo de modelos da conta da OpenAI, para o painel oferecer uma lista em
 * vez de exigir que alguém digite o id de cabeça.
 *
 * ⚠ A diferença para o catálogo da OpenRouter (`src/server/agents/catalogo.ts`)
 * é o que a API **não** diz. Lá vêm preço, contexto e `supported_parameters` —
 * dá para afirmar "este modelo aceita tools". Aqui `GET /models` devolve só
 * `{ id, created, owned_by }`: nada sobre enxergar imagem ou transcrever áudio.
 *
 * Por isso a classificação abaixo é **palpite declarado**, e o palpite nunca
 * esconde nada: o que não reconhecemos vai para "outros modelos da conta". Uma
 * lista que omitisse um modelo novo obrigaria a mexer em código para usar o que
 * já existe na conta — e é exatamente o que este catálogo existe para evitar.
 */

export type GrupoDeModelos = {
  rotulo: string;
  ids: string[];
};

/**
 * O que a conta lista e certamente não serve para ler mídia.
 *
 * Exclusão, e não uma lista do que serve: família nova de chat aparece sozinha
 * em "outros", enquanto embedding e TTS continuam fora para sempre. O caminho
 * inverso (lista fechada do que serve) envelheceria em semanas.
 */
const NAO_SERVE = [
  /embedding/i,
  /(^|-)tts(-|$)/i,
  /^dall-e/i,
  /^gpt-image/i,
  /^sora/i,
  /moderation/i,
  /realtime/i, // protocolo de WebSocket, não chat completions
  /^(davinci|babbage|curie|ada)(-|$)/i, // completions legado
];

/** Transcrição: o SDK instalado declara `whisper-1` e a família `*-transcribe`. */
const EH_TRANSCRICAO = /transcribe|^whisper/i;

/**
 * Modelo que aceita áudio DENTRO do chat, não no endpoint de transcrição.
 *
 * Parece servir pelo nome e não serve: `/audio/transcriptions` recusa. Fica
 * fora dos prováveis para ninguém escolher por engano.
 */
const EH_AUDIO_DE_CHAT = /audio-preview|-audio(-|$)/i;

export function ehExcluido(id: string): boolean {
  return NAO_SERVE.some((padrao) => padrao.test(id));
}

export function ehTranscricao(id: string): boolean {
  return EH_TRANSCRICAO.test(id) && !ehExcluido(id);
}

/**
 * Candidato a ler imagem e documento.
 *
 * Tudo que sobra depois de tirar o que certamente não serve — inclusive
 * transcrição, que é outro endpoint. "Provável", não "certo": só a chamada de
 * verdade prova, e é para isso que existe o teste com arquivo.
 */
export function ehProvavelDeTexto(id: string): boolean {
  return !ehExcluido(id) && !ehTranscricao(id) && !EH_AUDIO_DE_CHAT.test(id);
}

function ordenar(ids: string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/** Grupos do seletor de áudio: transcrição primeiro, resto depois. */
export function gruposParaAudio(ids: string[]): GrupoDeModelos[] {
  const transcricao = ordenar(ids.filter(ehTranscricao));
  const resto = ordenar(ids.filter((id) => !ehTranscricao(id)));

  return [
    { rotulo: "Transcrição", ids: transcricao },
    { rotulo: "Outros modelos da conta", ids: resto },
  ].filter((g) => g.ids.length > 0);
}

/** Grupos do seletor de imagem e documento. */
export function gruposParaTexto(ids: string[]): GrupoDeModelos[] {
  const provaveis = ordenar(ids.filter(ehProvavelDeTexto));
  const resto = ordenar(ids.filter((id) => !ehProvavelDeTexto(id)));

  return [
    { rotulo: "Prováveis (leem imagem e documento)", ids: provaveis },
    { rotulo: "Outros modelos da conta", ids: resto },
  ].filter((g) => g.ids.length > 0);
}

/**
 * Garante que o valor gravado tenha uma opção correspondente.
 *
 * Sem isto, o defeito documentado no AGENTS.md: um `<select>` com valor fora da
 * lista exibe a **primeira** opção e **envia ela** — bastaria a chave perder
 * acesso a um modelo para o painel trocar em silêncio o modelo de todo mundo,
 * na primeira vez que alguém salvasse a tela.
 */
export function comSelecionado(
  grupos: GrupoDeModelos[],
  selecionado: string,
): GrupoDeModelos[] {
  const alvo = selecionado.trim();
  if (!alvo) return grupos;
  if (grupos.some((g) => g.ids.includes(alvo))) return grupos;

  return [
    { rotulo: "Gravado (não aparece na conta agora)", ids: [alvo] },
    ...grupos,
  ];
}

const TTL_MS = 60 * 60 * 1000; // 1h, igual ao catálogo da OpenRouter
let cache: { ids: string[]; expiraEm: number } | null = null;

/**
 * Esvazia o cache. Chamado quando a chave é trocada: a conta pode ser outra, e
 * mostrar os modelos da conta anterior seria pior que não mostrar nada.
 */
export function limparCacheDeModelos() {
  cache = null;
}

export type CatalogoDaConta = {
  ids: string[];
  /** Por que a lista veio vazia, em texto para humano. */
  erro?: string;
};

/**
 * Modelos da conta, com cache.
 *
 * Nunca lança: a tela de Integrações precisa abrir mesmo com a OpenAI fora do
 * ar ou com chave restrita. Lista vazia + motivo faz o formulário cair para
 * campo de texto livre, que é o comportamento de antes deste catálogo existir.
 */
export async function modelosDaConta(
  config: OpenAIConfig,
  apiKey: string,
  opcoes: { forcar?: boolean } = {},
): Promise<CatalogoDaConta> {
  if (!opcoes.forcar && cache && cache.expiraEm > Date.now()) {
    return { ids: cache.ids };
  }

  try {
    const ids = await listarModelosDaConta(criarClienteOpenAI(config, apiKey));
    cache = { ids, expiraEm: Date.now() + TTL_MS };
    return { ids };
  } catch (erro) {
    const status = (erro as { status?: number } | null)?.status;

    // Chave restrita não lista modelos e ainda assim transcreve — mesmo caso do
    // token de Agent Bot do Chatwoot. Chamar isso de "chave inválida" mandaria
    // trocar uma credencial que está certa.
    if (status === 403) {
      return {
        ids: [],
        erro:
          "Esta chave não tem permissão para listar modelos (403) — o que é normal em chave restrita. Digite o id do modelo à mão; a leitura em si continua funcionando.",
      };
    }
    if (status === 401) {
      return { ids: [], erro: "A OpenAI recusou a chave (401)." };
    }

    logger.warn(
      { erro: erro instanceof Error ? erro.message : erro },
      "não consegui listar os modelos da OpenAI",
    );
    return {
      ids: [],
      erro:
        erro instanceof Error
          ? `Não consegui listar os modelos: ${erro.message}`
          : "Não consegui listar os modelos da conta.",
    };
  }
}
