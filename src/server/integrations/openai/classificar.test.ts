import { describe, expect, it } from "vitest";
import { MediaKind } from "@/generated/prisma/enums";
import {
  chaveDoAnexo,
  classificarAnexo,
  classificarAnexos,
  ehTextoPuro,
  partesDaUrl,
  tipoLigado,
} from "./classificar";

/**
 * Classificar é onde o dinheiro e o silêncio se decidem: um `.ogg` de WhatsApp
 * tratado como "não suportado" cala o agente, e um vídeo tratado como áudio
 * manda 40 MB para a OpenAI e volta erro pago.
 */

describe("classificação de anexo", () => {
  it("reconhece o áudio de WhatsApp — o caso mais comum de todos", () => {
    const a = classificarAnexo({
      id: 42,
      file_type: "audio",
      data_url: "https://chatwoot.seahub/rails/blobs/abc/mensagem.ogg",
    });

    expect(a?.kind).toBe(MediaKind.AUDIO);
    expect(a?.extensao).toBe("ogg");
    expect(a?.chave).toBe("chatwoot:42");
  });

  it("aceita opus e m4a, que é o que os canais mandam", () => {
    for (const ext of ["opus", "m4a", "mp3", "wav"]) {
      const a = classificarAnexo({
        id: 1,
        file_type: "audio",
        data_url: `https://cw/a.${ext}`,
      });
      expect(a?.kind, ext).toBe(MediaKind.AUDIO);
    }
  });

  it("recusa áudio em formato que a transcrição não aceita", () => {
    const a = classificarAnexo({
      id: 2,
      file_type: "audio",
      data_url: "https://cw/gravacao.amr",
    });

    expect(a?.kind).toBe(MediaKind.UNSUPPORTED);
    expect(a?.motivo).toContain("amr");
  });

  it("classifica vídeo como não suportado mesmo com extensão de áudio", () => {
    // `mp4` e `webm` valem para os dois. Se o vídeo caísse no ramo do áudio,
    // mandaríamos o arquivo inteiro para transcrever.
    const a = classificarAnexo({
      id: 3,
      file_type: "video",
      data_url: "https://cw/clipe.mp4",
    });

    expect(a?.kind).toBe(MediaKind.UNSUPPORTED);
    expect(a?.motivo).toContain("vídeo");
  });

  it("reconhece imagem e recusa formato que o modelo não lê", () => {
    expect(
      classificarAnexo({ id: 4, file_type: "image", data_url: "https://cw/f.jpg" })
        ?.kind,
    ).toBe(MediaKind.IMAGE);

    const heic = classificarAnexo({
      id: 5,
      file_type: "image",
      data_url: "https://cw/foto.heic",
    });
    expect(heic?.kind).toBe(MediaKind.UNSUPPORTED);
  });

  it("reconhece PDF e texto puro como documento", () => {
    expect(
      classificarAnexo({ id: 6, file_type: "file", data_url: "https://cw/c.pdf" })
        ?.kind,
    ).toBe(MediaKind.DOCUMENT);

    const txt = classificarAnexo({
      id: 7,
      file_type: "file",
      data_url: "https://cw/notas.txt",
    });
    expect(txt?.kind).toBe(MediaKind.DOCUMENT);
    expect(ehTextoPuro(txt!)).toBe(true);
  });

  it("texto puro não passa por modelo nenhum", () => {
    const pdf = classificarAnexo({
      id: 8,
      file_type: "file",
      data_url: "https://cw/contrato.pdf",
    });
    expect(ehTextoPuro(pdf!)).toBe(false);
  });

  it("localização vira contexto em vez de sumir", () => {
    const a = classificarAnexo({
      id: 9,
      file_type: "location",
      coordinates_lat: -23.5,
      coordinates_long: -46.6,
    });

    expect(a?.kind).toBe(MediaKind.UNSUPPORTED);
    expect(a?.motivo).toContain("-23.5");
  });

  it("anexo sem tipo e sem URL não vira nada", () => {
    expect(classificarAnexo({})).toBeNull();
  });

  it("descarta item malformado sem derrubar a lista", () => {
    const lista = classificarAnexos([
      null,
      "lixo",
      { id: 10, file_type: "image", data_url: "https://cw/ok.png" },
    ]);

    expect(lista).toHaveLength(1);
    expect(lista[0].kind).toBe(MediaKind.IMAGE);
  });

  it("aceita attachments ausente", () => {
    expect(classificarAnexos(undefined)).toEqual([]);
    expect(classificarAnexos(null)).toEqual([]);
    expect(classificarAnexos({ nao: "e array" })).toEqual([]);
  });
});

describe("chave de cache", () => {
  it("usa o id do Chatwoot quando existe", () => {
    expect(chaveDoAnexo({ id: 99 }, "https://cw/a.ogg")).toBe("chatwoot:99");
  });

  it("ignora a query da URL — assinatura que expira não pode mudar a chave", () => {
    // URL assinada do ActiveStorage muda a cada leitura do MESMO arquivo. Se a
    // query entrasse na chave, o áudio seria transcrito de novo a cada turno —
    // exatamente o que o cache existe para evitar.
    const a = chaveDoAnexo({}, "https://cw/blob/x.ogg?expires=1&sig=aaa");
    const b = chaveDoAnexo({}, "https://cw/blob/x.ogg?expires=2&sig=bbb");

    expect(a).toBe(b);
    expect(a.startsWith("url:")).toBe(true);
  });

  it("arquivos diferentes têm chaves diferentes", () => {
    expect(chaveDoAnexo({}, "https://cw/a.ogg")).not.toBe(
      chaveDoAnexo({}, "https://cw/b.ogg"),
    );
  });
});

describe("leitura da URL", () => {
  it("tira query e fragmento antes de olhar a extensão", () => {
    expect(partesDaUrl("https://cw/x/mensagem.OGG?a=1#z")).toEqual({
      nome: "mensagem.OGG",
      extensao: "ogg",
    });
  });

  it("decodifica nome com espaço e acento", () => {
    expect(partesDaUrl("https://cw/x/contrato%20assinado.pdf").nome).toBe(
      "contrato assinado.pdf",
    );
  });

  it("não estoura com URL sem extensão", () => {
    expect(partesDaUrl("https://cw/blob/abc").extensao).toBe("");
  });
});

describe("tipo ligado na configuração", () => {
  const config = { lerImagem: true, lerAudio: false, lerDocumento: true };

  it("respeita o desligamento por tipo", () => {
    expect(tipoLigado(MediaKind.AUDIO, config)).toBe(false);
    expect(tipoLigado(MediaKind.IMAGE, config)).toBe(true);
    expect(tipoLigado(MediaKind.DOCUMENT, config)).toBe(true);
  });

  it("o que não é lido por ninguém passa sempre — só vira aviso de texto", () => {
    expect(tipoLigado(MediaKind.UNSUPPORTED, config)).toBe(true);
  });
});
