import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaKind, MediaStatus } from "@/generated/prisma/enums";
import type { Anexo } from "./classificar";
import { lerConfigOpenAI } from "./config";

/**
 * O cache não é otimização: sem ele, o mesmo áudio é transcrito de novo a cada
 * mensagem seguinte da conversa, porque o worker relê o histórico inteiro do
 * Chatwoot em todo turno. A conta cresceria com o tamanho da conversa em vez de
 * com a quantidade de mídia — e é isso que estes testes travam.
 */

/** Linhas de MediaAnalysis, por chave. */
let banco: Map<string, Record<string, unknown>>;
/** Quantas vezes cada endpoint pago foi chamado. */
let chamadas: { download: number; audio: number; imagem: number; documento: number };
/** Erro que o próximo download deve lançar. */
let erroDoDownload: unknown = null;
/** Texto que a leitura devolve. */
let textoLido = "transcrição de exemplo";

vi.mock("@/lib/db", () => ({
  db: {
    mediaAnalysis: {
      findUnique: async ({ where }: { where: { chave: string } }) =>
        banco.get(where.chave) ?? null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { chave: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const atual = banco.get(where.chave);
        banco.set(where.chave, atual ? { ...atual, ...update } : { ...create });
        return banco.get(where.chave);
      },
    },
  },
}));

vi.mock("./client", async () => {
  const real = await vi.importActual<typeof import("./client")>("./client");
  return {
    ...real,
    baixarArquivo: async () => {
      chamadas.download++;
      if (erroDoDownload) throw erroDoDownload;
      return {
        bytes: Buffer.from("conteudo do arquivo"),
        mimeType: "audio/ogg",
        tamanhoBytes: 19,
      };
    },
    transcreverAudio: async () => {
      chamadas.audio++;
      return { texto: textoLido, model: "m-audio", inputTokens: 5, outputTokens: 7 };
    },
    descreverImagem: async () => {
      chamadas.imagem++;
      return { texto: textoLido, model: "m-visao", inputTokens: 9, outputTokens: 3 };
    },
    lerDocumento: async () => {
      chamadas.documento++;
      return { texto: textoLido, model: "m-doc", inputTokens: 4, outputTokens: 2 };
    },
  };
});

const { analisarAnexo, MAX_TENTATIVAS } = await import("./analise");
const { MidiaGrandeDemaisError } = await import("./client");

function ctx(extra: Partial<ReturnType<typeof lerConfigOpenAI>> = {}) {
  return {
    cliente: {} as never,
    config: { ...lerConfigOpenAI({}), ...extra },
    agentId: "agente-1",
  };
}

function anexo(kind: MediaKind, extra: Partial<Anexo> = {}): Anexo {
  return {
    chave: "chatwoot:1",
    kind,
    url: "https://cw/a.ogg",
    nome: "a.ogg",
    extensao: kind === MediaKind.AUDIO ? "ogg" : "png",
    tamanhoBytes: null,
    ...extra,
  };
}

beforeEach(() => {
  banco = new Map();
  chamadas = { download: 0, audio: 0, imagem: 0, documento: 0 };
  erroDoDownload = null;
  textoLido = "transcrição de exemplo";
});

describe("leitura de anexo com cache", () => {
  it("lê uma vez e reaproveita nas leituras seguintes", async () => {
    const a = anexo(MediaKind.AUDIO);

    const primeira = await analisarAnexo(a, ctx());
    expect(primeira.texto).toBe("transcrição de exemplo");
    expect(primeira.doCache).toBe(false);
    expect(chamadas.audio).toBe(1);

    // O worker relê o histórico inteiro a cada turno: esta é a segunda,
    // terceira, décima mensagem da mesma conversa.
    for (let i = 0; i < 5; i++) {
      const repetida = await analisarAnexo(a, ctx());
      expect(repetida.doCache).toBe(true);
      expect(repetida.texto).toBe("transcrição de exemplo");
    }

    expect(chamadas.audio).toBe(1);
    expect(chamadas.download).toBe(1);
  });

  it("grava o modelo e o uso, para a conta dar para conferir", async () => {
    await analisarAnexo(anexo(MediaKind.AUDIO), ctx());

    const linha = banco.get("chatwoot:1")!;
    expect(linha.model).toBe("m-audio");
    expect(linha.inputTokens).toBe(5);
    expect(linha.outputTokens).toBe(7);
    expect(linha.agentId).toBe("agente-1");
    expect(linha.status).toBe(MediaStatus.OK);
  });

  it("manda imagem e documento para o endpoint certo", async () => {
    await analisarAnexo(anexo(MediaKind.IMAGE, { chave: "k-img" }), ctx());
    await analisarAnexo(
      anexo(MediaKind.DOCUMENT, { chave: "k-doc", extensao: "pdf", nome: "c.pdf" }),
      ctx(),
    );

    expect(chamadas.imagem).toBe(1);
    expect(chamadas.documento).toBe(1);
    expect(chamadas.audio).toBe(0);
  });

  it("texto puro é lido direto, sem chamar modelo nenhum", async () => {
    const r = await analisarAnexo(
      anexo(MediaKind.DOCUMENT, { chave: "k-txt", extensao: "txt", nome: "n.txt" }),
      ctx(),
    );

    expect(r.texto).toBe("conteudo do arquivo");
    expect(chamadas.documento).toBe(0);
    expect(banco.get("k-txt")!.model).toBe("leitura-direta");
  });
});

describe("o que não vale a pena tentar de novo", () => {
  it("arquivo grande demais vira definitivo na primeira falha", async () => {
    erroDoDownload = new MidiaGrandeDemaisError(20);

    const r = await analisarAnexo(anexo(MediaKind.AUDIO), ctx());

    expect(r.status).toBe(MediaStatus.SKIPPED);
    expect(r.texto).toContain("grande demais");

    // E não tenta mais: insistir num arquivo grande demais só gastaria de novo.
    await analisarAnexo(anexo(MediaKind.AUDIO), ctx());
    expect(chamadas.download).toBe(1);
  });

  it("falha de rede tenta de novo, até o teto", async () => {
    erroDoDownload = new Error("socket hang up");

    for (let i = 1; i <= MAX_TENTATIVAS; i++) {
      const r = await analisarAnexo(anexo(MediaKind.AUDIO), ctx());
      const ultimo = i === MAX_TENTATIVAS;
      expect(r.status).toBe(ultimo ? MediaStatus.SKIPPED : MediaStatus.ERROR);
    }

    expect(chamadas.download).toBe(MAX_TENTATIVAS);

    // Estourou o teto: para de tentar, e o agente passa a receber o aviso.
    const depois = await analisarAnexo(anexo(MediaKind.AUDIO), ctx());
    expect(chamadas.download).toBe(MAX_TENTATIVAS);
    expect(depois.texto).toContain("não consegui ler");
  });

  it("chave recusada não é tratada como instabilidade", async () => {
    erroDoDownload = Object.assign(new Error("Unauthorized"), { status: 401 });

    const r = await analisarAnexo(anexo(MediaKind.AUDIO), ctx());

    expect(r.status).toBe(MediaStatus.SKIPPED);
    expect(r.texto).toContain("credencial da OpenAI recusada");
  });

  it("leitura vazia é definitiva — repetir daria o mesmo nada, pago", async () => {
    textoLido = "   ";

    const r = await analisarAnexo(anexo(MediaKind.AUDIO), ctx());

    expect(r.status).toBe(MediaStatus.SKIPPED);
    expect(r.texto).toContain("não havia conteúdo legível");

    await analisarAnexo(anexo(MediaKind.AUDIO), ctx());
    expect(chamadas.audio).toBe(1);
  });
});

describe("o que nem chega a ser lido", () => {
  it("vídeo vira contexto sem baixar nada", async () => {
    const r = await analisarAnexo(
      anexo(MediaKind.UNSUPPORTED, {
        chave: "k-video",
        motivo: "o cliente enviou um vídeo, que o sistema não consegue assistir",
      }),
      ctx(),
    );

    expect(r.status).toBe(MediaStatus.SKIPPED);
    expect(r.texto).toContain("vídeo");
    expect(chamadas.download).toBe(0);
  });

  it("tipo desligado na configuração não vai para o cache", async () => {
    // Religar a opção tem de voltar a ler sem ninguém precisar limpar tabela.
    const r = await analisarAnexo(anexo(MediaKind.AUDIO), ctx({ lerAudio: false }));

    expect(r.status).toBe(MediaStatus.SKIPPED);
    expect(chamadas.download).toBe(0);
    expect(banco.has("chatwoot:1")).toBe(false);

    const depois = await analisarAnexo(anexo(MediaKind.AUDIO), ctx());
    expect(depois.status).toBe(MediaStatus.OK);
  });
});
