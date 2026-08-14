import { createHash } from "node:crypto";
import { MediaKind } from "@/generated/prisma/enums";

/**
 * Classificação de anexo do Chatwoot: o que é, dá para ler, e com qual chave de
 * cache.
 *
 * Puro e testado porque é onde o dinheiro e o silêncio se decidem: classificar
 * um `.ogg` de WhatsApp como "não suportado" cala o agente; classificar um vídeo
 * como áudio manda 40 MB para a OpenAI e leva erro pago.
 */

/**
 * Anexo como o Chatwoot manda — no webhook e na listagem de mensagens.
 *
 * Propositalmente tolerante: o shape varia por versão e por canal (WhatsApp,
 * Instagram, widget). Campo que falta não pode derrubar o atendimento.
 */
export type AnexoBruto = {
  id?: number | string | null;
  /** `image` · `audio` · `video` · `file` · `location` · `contact` · … */
  file_type?: string | null;
  data_url?: string | null;
  file_url?: string | null;
  thumb_url?: string | null;
  extension?: string | null;
  file_size?: number | null;
  /** Localização vem com coordenadas em vez de arquivo. */
  coordinates_lat?: number | null;
  coordinates_long?: number | null;
  fallback_title?: string | null;
};

export type Anexo = {
  /** Chave de cache. Identifica o ARQUIVO, não a mensagem. */
  chave: string;
  kind: MediaKind;
  /** Vazio em `UNSUPPORTED` que não tem arquivo (localização, contato). */
  url: string;
  nome: string;
  extensao: string;
  tamanhoBytes: number | null;
  /**
   * Preenchido só em `UNSUPPORTED`: o texto que o agente recebe no lugar do
   * anexo. "O cliente mandou um vídeo" é contexto, não é nada.
   */
  motivo?: string;
};

/**
 * Formatos que cada endpoint da OpenAI aceita.
 *
 * Listas fechadas de propósito: mandar um `.heic` para a visão é 400 pago, e
 * mandar um `.amr` para a transcrição também. Melhor recusar aqui, de graça, e
 * dizer ao agente o que chegou.
 */
export const EXTENSOES_DE_IMAGEM = ["png", "jpg", "jpeg", "webp", "gif"];
export const EXTENSOES_DE_AUDIO = [
  "flac",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "m4a",
  "ogg",
  "oga",
  "opus",
  "wav",
  "webm",
];
/** Documento que o modelo lê como arquivo. */
export const EXTENSOES_DE_PDF = ["pdf"];
/** Texto puro: lido direto, sem passar por modelo nenhum — e portanto de graça. */
export const EXTENSOES_DE_TEXTO = ["txt", "csv", "md", "json", "log", "xml", "yml", "yaml"];

const TIPO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  webm: "audio/webm",
  flac: "audio/flac",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  json: "application/json",
};

export function mimeDaExtensao(extensao: string): string {
  return TIPO_MIME[extensao] ?? "application/octet-stream";
}

/** Texto puro não precisa de modelo — o arquivo já é a resposta. */
export function ehTextoPuro(anexo: Anexo): boolean {
  return (
    anexo.kind === MediaKind.DOCUMENT &&
    EXTENSOES_DE_TEXTO.includes(anexo.extensao)
  );
}

/**
 * Extrai extensão e nome do arquivo a partir da URL.
 *
 * A query string é descartada: URL de ActiveStorage do Chatwoot pode vir
 * assinada e com validade, e a assinatura muda entre leituras do MESMO arquivo.
 * Deixá-la na chave de cache faria transcrever o mesmo áudio de novo a cada
 * turno — exatamente o que o cache existe para evitar.
 */
export function partesDaUrl(url: string): { nome: string; extensao: string } {
  const semQuery = url.split("?")[0].split("#")[0];
  const ultimo = decodeURIComponentSeguro(
    semQuery.split("/").filter(Boolean).pop() ?? "",
  );
  const ponto = ultimo.lastIndexOf(".");
  const extensao = ponto > 0 ? ultimo.slice(ponto + 1).toLowerCase() : "";

  return { nome: ultimo || "arquivo", extensao };
}

function decodeURIComponentSeguro(valor: string): string {
  try {
    return decodeURIComponent(valor);
  } catch {
    return valor;
  }
}

/** Chave estável do arquivo. O id do Chatwoot quando existe; senão, o hash. */
export function chaveDoAnexo(bruto: AnexoBruto, url: string): string {
  if (bruto.id != null && String(bruto.id).trim() !== "") {
    return `chatwoot:${bruto.id}`;
  }
  const semQuery = url.split("?")[0];
  return `url:${createHash("sha256").update(semQuery).digest("hex").slice(0, 40)}`;
}

/**
 * O que este anexo é e se dá para lê-lo.
 *
 * `null` só quando não há nada a dizer ao agente (anexo sem tipo e sem URL).
 * Todo o resto vira um `Anexo` — inclusive o que não conseguimos ler, porque o
 * agente precisa saber que chegou alguma coisa.
 */
export function classificarAnexo(bruto: AnexoBruto): Anexo | null {
  const tipo = (bruto.file_type ?? "").toLowerCase().trim();
  const url = (bruto.data_url || bruto.file_url || "").trim();

  // Localização e contato não têm arquivo — e mesmo assim são informação boa.
  if (tipo === "location") {
    const coords =
      bruto.coordinates_lat != null && bruto.coordinates_long != null
        ? ` (${bruto.coordinates_lat}, ${bruto.coordinates_long})`
        : "";
    return semArquivo(
      bruto,
      `o cliente enviou uma localização${coords}${
        bruto.fallback_title ? ` — ${bruto.fallback_title}` : ""
      }`,
    );
  }

  if (tipo === "contact") {
    return semArquivo(bruto, "o cliente enviou um cartão de contato");
  }

  if (!url) {
    if (!tipo) return null;
    return semArquivo(bruto, `o cliente enviou um anexo do tipo "${tipo}"`);
  }

  const { nome, extensao } = partesDaUrl(url);
  const base = {
    chave: chaveDoAnexo(bruto, url),
    url,
    nome,
    extensao,
    tamanhoBytes: bruto.file_size ?? null,
  };

  // Vídeo primeiro: a extensão de vídeo colide com a de áudio (`mp4`, `webm`),
  // e transcrever um vídeo de 40 MB seria caro e provavelmente inútil.
  if (tipo === "video") {
    return {
      ...base,
      kind: MediaKind.UNSUPPORTED,
      motivo: "o cliente enviou um vídeo, que o sistema não consegue assistir",
    };
  }

  if (tipo === "audio" || EXTENSOES_DE_AUDIO.includes(extensao)) {
    if (!EXTENSOES_DE_AUDIO.includes(extensao)) {
      return {
        ...base,
        kind: MediaKind.UNSUPPORTED,
        motivo: `o cliente enviou um áudio em formato que não dá para transcrever (${extensao || "sem extensão"})`,
      };
    }
    return { ...base, kind: MediaKind.AUDIO };
  }

  if (tipo === "image" || EXTENSOES_DE_IMAGEM.includes(extensao)) {
    if (!EXTENSOES_DE_IMAGEM.includes(extensao)) {
      return {
        ...base,
        kind: MediaKind.UNSUPPORTED,
        motivo: `o cliente enviou uma imagem em formato que o modelo não lê (${extensao || "sem extensão"})`,
      };
    }
    return { ...base, kind: MediaKind.IMAGE };
  }

  if (
    EXTENSOES_DE_PDF.includes(extensao) ||
    EXTENSOES_DE_TEXTO.includes(extensao)
  ) {
    return { ...base, kind: MediaKind.DOCUMENT };
  }

  return {
    ...base,
    kind: MediaKind.UNSUPPORTED,
    motivo: `o cliente enviou um arquivo ${
      extensao ? `.${extensao}` : "sem extensão reconhecida"
    } que o sistema não consegue abrir`,
  };
}

function semArquivo(bruto: AnexoBruto, motivo: string): Anexo {
  return {
    chave: chaveDoAnexo(bruto, motivo),
    kind: MediaKind.UNSUPPORTED,
    url: "",
    nome: "",
    extensao: "",
    tamanhoBytes: null,
    motivo,
  };
}

/**
 * Classifica a lista inteira, descartando o que não diz nada.
 *
 * Recebe `unknown` de propósito: o `attachments` vem de payload de webhook e de
 * resposta de API, e a validação é aqui — não na tipagem de quem chama.
 */
export function classificarAnexos(brutos: unknown): Anexo[] {
  if (!Array.isArray(brutos)) return [];
  return brutos
    .filter((a): a is AnexoBruto => typeof a === "object" && a !== null)
    .map(classificarAnexo)
    .filter((a): a is Anexo => a !== null);
}

/** Um anexo desligado na configuração não é erro — é escolha. */
export function tipoLigado(
  kind: MediaKind,
  config: { lerImagem: boolean; lerAudio: boolean; lerDocumento: boolean },
): boolean {
  if (kind === MediaKind.IMAGE) return config.lerImagem;
  if (kind === MediaKind.AUDIO) return config.lerAudio;
  if (kind === MediaKind.DOCUMENT) return config.lerDocumento;
  return true; // UNSUPPORTED não consome nada: só vira aviso de texto
}
