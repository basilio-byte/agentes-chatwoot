import { describe, expect, it } from "vitest";
import {
  conteudoLegivel,
  lerTranscricao,
  recortar,
  TETO_DE_TEXTO,
} from "./trace";

describe("conteúdo da mensagem", () => {
  it("passa string direto", () => {
    expect(conteudoLegivel("olá")).toBe("olá");
  });

  it("junta blocos de texto", () => {
    expect(conteudoLegivel([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe(
      "a\nb",
    );
  });

  it("nulo vira vazio, não a palavra null", () => {
    expect(conteudoLegivel(null)).toBe("");
    expect(conteudoLegivel(undefined)).toBe("");
  });
});

describe("transcrição", () => {
  it("lê papel e conteúdo de cada mensagem", () => {
    const { mensagens } = lerTranscricao([
      { role: "system", content: "prompt" },
      { role: "user", content: "oi" },
      { role: "assistant", content: "olá" },
    ]);

    expect(mensagens.map((m) => m.papel)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    expect(mensagens[2].conteudo).toBe("olá");
  });

  it("mostra as tools pedidas na mensagem do modelo", () => {
    // A chamada de tool não está em `content`: sem ler `tool_calls`, o turno
    // pareceria uma mensagem vazia no meio da transcrição.
    const { mensagens } = lerTranscricao([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { function: { name: "clickup_obter_tarefa" } },
          { function: { name: "zapsign_ver_modelo" } },
        ],
      },
    ]);

    expect(mensagens[0].toolsPedidas).toEqual([
      "clickup_obter_tarefa",
      "zapsign_ver_modelo",
    ]);
    expect(mensagens[0].conteudo).toBe("");
  });

  it("aguenta mensagem malformada sem derrubar a tela", () => {
    const { mensagens } = lerTranscricao([null, {}, { role: 7 }]);
    expect(mensagens.map((m) => m.papel)).toEqual(["?", "?", "?"]);
  });

  it("messages que não é lista devolve vazio", () => {
    // Execução que morreu cedo pode ter gravado outra coisa ali.
    expect(lerTranscricao(null).mensagens).toEqual([]);
    expect(lerTranscricao({ erro: true }).mensagens).toEqual([]);
  });

  it("avisa quando cortou por tamanho", () => {
    const gigante = "x".repeat(TETO_DE_TEXTO + 10);
    const { mensagens, cortada } = lerTranscricao([
      { role: "tool", content: gigante },
    ]);

    expect(cortada).toBe(true);
    expect(mensagens[0].conteudo).toHaveLength(TETO_DE_TEXTO);
  });

  it("não corta o que cabe", () => {
    expect(recortar("curto")).toEqual({ texto: "curto", cortado: false });
  });

  it("serializa objeto de tool como JSON legível", () => {
    expect(recortar({ id: "abc" }).texto).toBe('{\n  "id": "abc"\n}');
  });
});
