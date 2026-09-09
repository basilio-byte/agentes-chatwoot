import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaKind, MediaStatus } from "@/generated/prisma/enums";
import { lerConfigOpenAI } from "./config";

/**
 * A mesa é um caminho PAGO que não passa por `analisarAnexo`.
 *
 * Estes testes travam as duas coisas que um adaptador ingênuo perderia sem dar
 * erro nenhum: os toggles por tipo (`tipoLigado` só era chamado dentro de
 * `analisarAnexo`, então quem despacha direto ao `client.ts` cobra o operador
 * por uma leitura que ele desligou) e a ausência de cache (a mesa não tem
 * releitura de histórico, e `MediaAnalysis` não tem dono — cachear por conteúdo
 * entregaria o documento de uma pessoa a outra).
 */

/** Linhas criadas em MediaAnalysis. */
let criadas: Record<string, unknown>[];
/** Toda tentativa de LER a tabela — que na mesa tem de ser zero. */
let buscasNoCache: number;
/** Quantas vezes cada endpoint pago foi chamado. */
let chamadas: { audio: number; imagem: number; documento: number };
/** Erro que a próxima leitura deve lançar. */
let erroDaLeitura: unknown = null;
/** Texto que a leitura devolve. */
let textoLido = "texto extraído do arquivo";

vi.mock("@/lib/db", () => ({
  db: {
    mediaAnalysis: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        criadas.push(data);
        return { id: `linha-${criadas.length}`, ...data };
      },
      findUnique: async () => {
        buscasNoCache++;
        return null;
      },
      findFirst: async () => {
        buscasNoCache++;
        return null;
      },
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        buscasNoCache++;
        criadas.push(create);
        return create;
      },
    },
  },
}));

vi.mock("./client", async () => {
  const real = await vi.importActual<typeof import("./client")>("./client");
  return {
    ...real,
    transcreverAudio: async () => {
      chamadas.audio++;
      if (erroDaLeitura) throw erroDaLeitura;
      return { texto: textoLido, model: "m-audio", inputTokens: 5, outputTokens: 7 };
    },
    descreverImagem: async () => {
      chamadas.imagem++;
      if (erroDaLeitura) throw erroDaLeitura;
      return { texto: textoLido, model: "m-visao", inputTokens: 9, outputTokens: 3 };
    },
    lerDocumento: async () => {
      chamadas.documento++;
      if (erroDaLeitura) throw erroDaLeitura;
      return { texto: textoLido, model: "m-doc", inputTokens: 4, outputTokens: 2 };
    },
  };
});

const { lerArquivoEnviado } = await import("./upload");

type Entrada = Parameters<typeof lerArquivoEnviado>[0];

function entrada(extra: Partial<Entrada> = {}): Entrada {
  return {
    bytes: Buffer.from("conteudo do arquivo"),
    nome: "contrato.pdf",
    // `mimeType` é obrigatório no tipo justamente para ninguém esquecer dele —
    // aqui o padrão é o navegador não ter declarado nada.
    mimeType: null,
    config: lerConfigOpenAI({}),
    cliente: {} as never,
    agentId: "agente-1",
    ...extra,
  };
}

/** Config com um toggle mexido, sem perder os defaults. */
function config(extra: Partial<ReturnType<typeof lerConfigOpenAI>>) {
  return { ...lerConfigOpenAI({}), ...extra };
}

function totalDeChamadas(): number {
  return chamadas.audio + chamadas.imagem + chamadas.documento;
}

beforeEach(() => {
  criadas = [];
  buscasNoCache = 0;
  chamadas = { audio: 0, imagem: 0, documento: 0 };
  erroDaLeitura = null;
  textoLido = "texto extraído do arquivo";
});

describe("leitura do arquivo enviado", () => {
  it("manda cada tipo para o endpoint certo", async () => {
    await lerArquivoEnviado(entrada());
    expect(chamadas.documento).toBe(1);

    await lerArquivoEnviado(entrada({ nome: "foto.jpg" }));
    expect(chamadas.imagem).toBe(1);

    await lerArquivoEnviado(entrada({ nome: "recado.ogg" }));
    expect(chamadas.audio).toBe(1);
  });

  it("devolve o texto e o modelo que leu", async () => {
    const r = await lerArquivoEnviado(entrada());

    expect(r.status).toBe(MediaStatus.OK);
    expect(r.texto).toBe("texto extraído do arquivo");
    expect(r.motivo).toBeNull();
    expect(r.model).toBe("m-doc");
    expect(r.kind).toBe(MediaKind.DOCUMENT);
  });

  it("texto puro é lido direto, sem chamar modelo nenhum", async () => {
    const r = await lerArquivoEnviado(
      entrada({ nome: "lista.csv", bytes: Buffer.from("nome;cpf") }),
    );

    expect(r.texto).toBe("nome;cpf");
    expect(totalDeChamadas()).toBe(0);
    expect(criadas[0].model).toBe("leitura-direta");
  });

  it("leitura sem conteúdo não vira texto vazio na cara de quem enviou", async () => {
    textoLido = "   ";

    const r = await lerArquivoEnviado(entrada());

    expect(r.status).toBe(MediaStatus.SKIPPED);
    expect(r.texto).toBeNull();
    expect(r.motivo).toContain("não havia conteúdo legível");
    // Foi paga: o registro contábil tem de existir mesmo sem texto.
    expect(criadas).toHaveLength(1);
  });
});

describe("os toggles por tipo valem aqui também", () => {
  // ⚠ O defeito que este módulo existe para não repetir: `tipoLigado` era
  // chamado em UM lugar (`analise.ts`), e a mesa não passa por lá. Sem esta
  // checagem o operador desliga a leitura em Integrações, o worker obedece, e a
  // mesa continua enviando e sendo cobrada — sem erro e sem rastro.
  it("imagem desligada não é enviada nem cobrada", async () => {
    const r = await lerArquivoEnviado(
      entrada({ nome: "foto.jpg", config: config({ lerImagem: false }) }),
    );

    expect(chamadas.imagem).toBe(0);
    expect(r.status).toBe(MediaStatus.SKIPPED);
    expect(r.texto).toBeNull();
    expect(r.motivo).toContain("não está sendo lido");
    expect(r.motivo).toContain("foto.jpg");
  });

  it("áudio desligado não é enviado nem cobrado", async () => {
    const r = await lerArquivoEnviado(
      entrada({ nome: "recado.ogg", config: config({ lerAudio: false }) }),
    );

    expect(chamadas.audio).toBe(0);
    expect(r.motivo).toContain("não está sendo lido");
  });

  it("documento desligado não é enviado nem cobrado", async () => {
    const r = await lerArquivoEnviado(
      entrada({ config: config({ lerDocumento: false }) }),
    );

    expect(chamadas.documento).toBe(0);
    expect(r.motivo).toContain("não está sendo lido");
  });

  it("desligado também vale para o .txt, que não custaria nada", async () => {
    // Continua sendo escolha do operador: "ler documento" desligado quer dizer
    // que a mesa não abre documento, e não que ela abre os baratos.
    const r = await lerArquivoEnviado(
      entrada({ nome: "notas.txt", config: config({ lerDocumento: false }) }),
    );

    expect(r.texto).toBeNull();
    expect(r.motivo).toContain("não está sendo lido");
  });

  it("religar volta a ler, porque a recusa não deixou nada gravado", async () => {
    await lerArquivoEnviado(
      entrada({ nome: "foto.jpg", config: config({ lerImagem: false }) }),
    );
    expect(criadas).toHaveLength(0);

    const depois = await lerArquivoEnviado(entrada({ nome: "foto.jpg" }));
    expect(depois.status).toBe(MediaStatus.OK);
  });
});

describe("o que é recusado de graça, antes de gastar", () => {
  // ⚠ `.heic` na visão e `.amr` na transcrição são 400 PAGO. A lista fechada de
  // `classificar.ts` existe para isso não ser descoberto na fatura.
  it("formato fora da lista fechada não chega à OpenAI", async () => {
    for (const nome of ["selfie.heic", "recado.amr"]) {
      const r = await lerArquivoEnviado(entrada({ nome }));

      expect(totalDeChamadas()).toBe(0);
      expect(r.status).toBe(MediaStatus.SKIPPED);
      expect(r.kind).toBe(MediaKind.UNSUPPORTED);
      // Diz o que chegou: é o que permite converter o arquivo em vez de
      // reenviar o mesmo e receber a mesma recusa.
      expect(r.motivo).toContain(nome);
    }
  });

  it("arquivo sem extensão nenhuma também é recusado", async () => {
    const r = await lerArquivoEnviado(entrada({ nome: "documento" }));

    expect(totalDeChamadas()).toBe(0);
    expect(r.motivo).toContain("sem extensão");
  });

  it("vídeo não vai para a transcrição, mesmo com extensão de áudio", async () => {
    // `mp4` e `webm` são extensão de áudio E de vídeo — a mesma armadilha de
    // `classificarAnexo`, resolvida aqui pelo tipo que o navegador declara.
    const r = await lerArquivoEnviado(
      entrada({ nome: "visita.mp4", mimeType: "video/mp4" }),
    );

    expect(chamadas.audio).toBe(0);
    expect(r.motivo).toContain("vídeo");
  });

  it("arquivo acima do teto configurado é recusado antes da chamada", async () => {
    const r = await lerArquivoEnviado(
      entrada({
        bytes: Buffer.alloc(2 * 1024 * 1024),
        config: config({ tamanhoMaximoMb: 1 }),
      }),
    );

    expect(totalDeChamadas()).toBe(0);
    expect(r.motivo).toContain("2.0 MB");
    expect(r.motivo).toContain("1 MB");
  });

  it("recusa não vira linha em MediaAnalysis", async () => {
    await lerArquivoEnviado(entrada({ nome: "selfie.heic" }));
    await lerArquivoEnviado(
      entrada({ bytes: Buffer.alloc(2 * 1024 * 1024), config: config({ tamanhoMaximoMb: 1 }) }),
    );

    expect(criadas).toHaveLength(0);
  });
});

describe("registro contábil", () => {
  it("grava a leitura com modelo, uso e procedência", async () => {
    await lerArquivoEnviado(entrada());

    expect(criadas).toHaveLength(1);
    const linha = criadas[0];
    expect(linha.status).toBe(MediaStatus.OK);
    expect(linha.model).toBe("m-doc");
    expect(linha.inputTokens).toBe(4);
    expect(linha.outputTokens).toBe(2);
    expect(linha.agentId).toBe("agente-1");
    expect(linha.nomeArquivo).toBe("contrato.pdf");
  });

  it("a chave é `mesa:` e nunca se repete", async () => {
    await lerArquivoEnviado(entrada());
    await lerArquivoEnviado(entrada());

    const chaves = criadas.map((l) => String(l.chave));
    expect(chaves).toHaveLength(2);
    for (const chave of chaves) expect(chave.startsWith("mesa:")).toBe(true);
    expect(new Set(chaves).size).toBe(2);
  });

  it("banco fora do ar não faz perder o texto que já foi pago", async () => {
    const { db } = await import("@/lib/db");
    const create = vi
      .spyOn(db.mediaAnalysis, "create")
      .mockRejectedValueOnce(new Error("connection refused"));

    const r = await lerArquivoEnviado(entrada());

    expect(r.texto).toBe("texto extraído do arquivo");
    expect(r.status).toBe(MediaStatus.OK);
    create.mockRestore();
  });
});

describe("a mesa não cacheia, e é de propósito", () => {
  // ⚠ Cachear por conteúdo vazaria documento entre usuários: `MediaAnalysis`
  // não tem dono, e o mesmo PDF enviado por duas pessoas tem o mesmo hash. O
  // cache existe para a releitura do histórico do Chatwoot, que aqui não há.
  it("o mesmo arquivo enviado duas vezes é lido duas vezes", async () => {
    const bytes = Buffer.from("o mesmo conteúdo, byte a byte");

    const primeira = await lerArquivoEnviado(entrada({ bytes }));
    const segunda = await lerArquivoEnviado(entrada({ bytes }));

    expect(chamadas.documento).toBe(2);
    expect(criadas).toHaveLength(2);
    expect(primeira.chave).not.toBe(segunda.chave);
  });

  it("nenhuma leitura consulta a tabela antes de ler", async () => {
    await lerArquivoEnviado(entrada());
    await lerArquivoEnviado(entrada({ nome: "foto.jpg" }));

    expect(buscasNoCache).toBe(0);
  });
});

describe("falha de leitura vira texto, nunca exceção", () => {
  it("erro de credencial não vaza a mensagem crua da OpenAI", async () => {
    // A mensagem da OpenAI chega a repetir pedaço da chave enviada — e este
    // motivo vai direto para a tela de quem mandou o arquivo.
    erroDaLeitura = Object.assign(
      new Error("Incorrect API key provided: sk-proj-ABC123DEF456"),
      { status: 401 },
    );

    const r = await lerArquivoEnviado(entrada());

    expect(r.status).toBe(MediaStatus.SKIPPED);
    expect(r.texto).toBeNull();
    expect(r.motivo).toContain("credencial da OpenAI recusada");
    expect(r.motivo).not.toContain("sk-proj");
  });

  it("falha depois da chamada continua gravada — pode ter sido cobrada", async () => {
    erroDaLeitura = Object.assign(new Error("Bad gateway"), { status: 502 });

    const r = await lerArquivoEnviado(entrada());

    expect(r.motivo).toContain("não consegui ler este arquivo");
    expect(criadas).toHaveLength(1);
    expect(criadas[0].status).toBe(MediaStatus.SKIPPED);
    expect(criadas[0].erro).toContain("Bad gateway");
  });

  it("erro inesperado não derruba a mesa", async () => {
    erroDaLeitura = "explodiu sem ser Error";

    const r = await lerArquivoEnviado(entrada());

    expect(r.status).toBe(MediaStatus.SKIPPED);
    expect(r.motivo).toContain("não consegui ler este arquivo");
  });
});
