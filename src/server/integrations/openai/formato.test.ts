import { describe, expect, it } from "vitest";
import { MediaKind } from "@/generated/prisma/enums";
import {
  avisoDeLeituraDesligada,
  cortar,
  juntarComAnexos,
  linhaDoAnexo,
  TETO_DE_TEXTO_POR_ANEXO,
} from "./formato";

describe("como o anexo lido chega ao modelo", () => {
  it("marca a transcrição como transcrição", () => {
    // Sem a marcação, o modelo trata o áudio transcrito como se a pessoa
    // tivesse digitado aquilo — e responde "conforme você escreveu".
    const linha = linhaDoAnexo({
      kind: MediaKind.AUDIO,
      nome: "audio.ogg",
      texto: "oi, queria uma sala para amanhã",
    });

    expect(linha).toBe(
      "[áudio transcrito — audio.ogg] oi, queria uma sala para amanhã",
    );
  });

  it("usa o rótulo sem nome quando o arquivo não tem nome", () => {
    expect(linhaDoAnexo({ kind: MediaKind.IMAGE, texto: "um recibo" })).toBe(
      "[imagem] um recibo",
    );
  });

  it("a falha vira texto — o agente precisa saber que chegou algo", () => {
    const linha = linhaDoAnexo({
      kind: MediaKind.DOCUMENT,
      nome: "c.pdf",
      falha: "não consegui ler este anexo (arquivo grande demais)",
    });

    expect(linha).toContain("[documento — c.pdf]");
    expect(linha).toContain("grande demais");
  });

  it("anexo sem texto e sem falha ainda diz alguma coisa", () => {
    expect(linhaDoAnexo({ kind: MediaKind.IMAGE })).toContain(
      "não foi possível ler",
    );
  });

  it("corta texto gigante e mostra que cortou", () => {
    const gigante = "a".repeat(TETO_DE_TEXTO_POR_ANEXO + 500);
    const cortado = cortar(gigante);

    expect(cortado.length).toBeLessThan(gigante.length);
    expect(cortado).toContain("texto cortado");
  });

  it("não mexe em texto dentro do teto", () => {
    expect(cortar("  curto  ")).toBe("curto");
  });
});

describe("junção com o que o cliente digitou", () => {
  it("o texto digitado vem primeiro, o anexo é apoio", () => {
    const m = juntarComAnexos("olha o comprovante", [
      { kind: MediaKind.IMAGE, nome: "p.png", texto: "PIX de R$ 350,00" },
    ]);

    expect(m).toBe("olha o comprovante\n[imagem — p.png] PIX de R$ 350,00");
  });

  it("mensagem só com áudio passa a ter conteúdo", () => {
    // Este é o caso que fazia o bot ficar mudo: sem texto, `montarContexto`
    // descartava a mensagem inteira.
    const m = juntarComAnexos(null, [
      { kind: MediaKind.AUDIO, nome: "a.ogg", texto: "quero reservar" },
    ]);

    expect(m).toBe("[áudio transcrito — a.ogg] quero reservar");
    expect(m.trim().length).toBeGreaterThan(0);
  });

  it("sem anexo, devolve o texto como estava", () => {
    expect(juntarComAnexos("oi", [])).toBe("oi");
    expect(juntarComAnexos(null, [])).toBe("");
  });

  it("vários anexos viram uma linha cada", () => {
    const m = juntarComAnexos("", [
      { kind: MediaKind.AUDIO, texto: "um" },
      { kind: MediaKind.IMAGE, texto: "dois" },
    ]);

    expect(m.split("\n")).toHaveLength(2);
  });
});

describe("aviso de leitura desligada", () => {
  it("diz que chegou anexo mesmo sem poder lê-lo", () => {
    // Sem isto o agente recebia mensagem vazia e respondia "não entendi",
    // sem nunca dizer que havia um áudio — e o cliente reenviava para sempre.
    expect(avisoDeLeituraDesligada(1)).toContain("anexo");
    expect(avisoDeLeituraDesligada(3)).toContain("3 anexos");
  });
});
