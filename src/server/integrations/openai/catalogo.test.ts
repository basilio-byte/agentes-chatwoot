import { describe, expect, it } from "vitest";
import {
  comSelecionado,
  ehExcluido,
  ehProvavelDeTexto,
  ehTranscricao,
  gruposParaAudio,
  gruposParaTexto,
} from "./catalogo";

/**
 * `GET /models` da OpenAI devolve a conta inteira e não diz o que cada modelo
 * faz. A classificação aqui é palpite declarado — e o que ela nunca pode fazer
 * é **esconder**: modelo que não reconhecemos vai para "outros", senão usar um
 * lançamento novo exigiria mexer em código.
 */

/** Amostra no formato que a conta devolve: útil e inútil misturados. */
const CONTA = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "whisper-1",
  "text-embedding-3-small",
  "tts-1",
  "gpt-4o-mini-tts",
  "dall-e-3",
  "gpt-image-1",
  "omni-moderation-latest",
  "gpt-4o-realtime-preview",
  "gpt-4o-audio-preview",
  "davinci-002",
  "modelo-que-ainda-nao-existe-2027",
];

describe("o que certamente não serve", () => {
  it("tira embedding, TTS, geração de imagem, moderação, realtime e legado", () => {
    for (const id of [
      "text-embedding-3-small",
      "tts-1",
      "gpt-4o-mini-tts",
      "dall-e-3",
      "gpt-image-1",
      "omni-moderation-latest",
      "gpt-4o-realtime-preview",
      "davinci-002",
    ]) {
      expect(ehExcluido(id), id).toBe(true);
    }
  });

  it("não tira modelo de chat comum", () => {
    for (const id of ["gpt-4o", "gpt-4o-mini", "o3", "gpt-5.6"]) {
      expect(ehExcluido(id), id).toBe(false);
    }
  });
});

describe("transcrição", () => {
  it("reconhece whisper e a família transcribe", () => {
    expect(ehTranscricao("whisper-1")).toBe(true);
    expect(ehTranscricao("gpt-4o-transcribe")).toBe(true);
    expect(ehTranscricao("gpt-4o-mini-transcribe")).toBe(true);
    expect(ehTranscricao("gpt-4o-transcribe-diarize")).toBe(true);
  });

  it("não confunde transcrição com TTS, que é o caminho contrário", () => {
    expect(ehTranscricao("tts-1")).toBe(false);
    expect(ehTranscricao("gpt-4o-mini-tts")).toBe(false);
  });

  it("modelo de chat não é de transcrição", () => {
    expect(ehTranscricao("gpt-4o")).toBe(false);
  });
});

describe("prováveis para imagem e documento", () => {
  it("aceita chat e recusa o que não é chat", () => {
    expect(ehProvavelDeTexto("gpt-4o")).toBe(true);
    expect(ehProvavelDeTexto("text-embedding-3-small")).toBe(false);
    expect(ehProvavelDeTexto("dall-e-3")).toBe(false);
  });

  it("transcrição não entra: é outro endpoint", () => {
    expect(ehProvavelDeTexto("gpt-4o-transcribe")).toBe(false);
  });

  it("modelo de áudio-no-chat fica fora dos prováveis", () => {
    // Parece servir pelo nome e não serve em `/audio/transcriptions`. Deixá-lo
    // entre os prováveis convidaria ao engano.
    expect(ehProvavelDeTexto("gpt-4o-audio-preview")).toBe(false);
  });

  it("modelo desconhecido é tratado como provável, não descartado", () => {
    // O caso que importa: lançamento novo tem de aparecer sem deploy.
    expect(ehProvavelDeTexto("modelo-que-ainda-nao-existe-2027")).toBe(true);
  });
});

describe("grupos do seletor", () => {
  it("no seletor de áudio, transcrição vem primeiro", () => {
    const grupos = gruposParaAudio(CONTA);

    expect(grupos[0].rotulo).toBe("Transcrição");
    expect(grupos[0].ids).toEqual([
      "gpt-4o-mini-transcribe",
      "gpt-4o-transcribe",
      "whisper-1",
    ]);
  });

  it("nada é escondido — o que sobra vai para 'outros'", () => {
    const grupos = gruposParaAudio(CONTA);
    const todos = grupos.flatMap((g) => g.ids);

    expect(todos.sort()).toEqual([...CONTA].sort());
  });

  it("no seletor de texto, o que sobra também aparece", () => {
    const grupos = gruposParaTexto(CONTA);
    const todos = grupos.flatMap((g) => g.ids);

    expect(todos.sort()).toEqual([...CONTA].sort());
    expect(grupos[0].ids).toContain("gpt-4o");
    expect(grupos[0].ids).not.toContain("dall-e-3");
  });

  it("grupo vazio não aparece", () => {
    expect(gruposParaAudio(["gpt-4o"]).map((g) => g.rotulo)).toEqual([
      "Outros modelos da conta",
    ]);
  });

  it("lista vazia não vira grupo vazio", () => {
    expect(gruposParaTexto([])).toEqual([]);
  });
});

describe("o valor gravado sempre tem opção", () => {
  /**
   * Sem isto, o defeito documentado no AGENTS.md: `<select>` com valor fora da
   * lista exibe a PRIMEIRA opção e envia ela. Bastaria a chave perder acesso a
   * um modelo para o painel trocar o modelo de todo mundo, em silêncio, na
   * primeira vez que alguém salvasse a tela.
   */
  it("acrescenta o gravado quando ele sumiu da conta", () => {
    const grupos = comSelecionado(gruposParaTexto(["gpt-4o"]), "modelo-antigo");

    expect(grupos[0].rotulo).toContain("Gravado");
    expect(grupos[0].ids).toEqual(["modelo-antigo"]);
  });

  it("não duplica quando o gravado está na lista", () => {
    const grupos = comSelecionado(gruposParaTexto(CONTA), "gpt-4o");

    expect(grupos.flatMap((g) => g.ids).filter((id) => id === "gpt-4o")).toEqual([
      "gpt-4o",
    ]);
  });

  it("valor em branco não cria grupo", () => {
    const base = gruposParaTexto(CONTA);
    expect(comSelecionado(base, "")).toBe(base);
    expect(comSelecionado(base, "   ")).toBe(base);
  });
});
