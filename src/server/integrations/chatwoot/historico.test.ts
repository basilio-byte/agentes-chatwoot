import { describe, expect, it } from "vitest";
import { montarContexto } from "./historico";
import type { MensagemChatwoot } from "./client";

function msg(
  id: number,
  tipo: 0 | 1 | 2 | 3,
  content: string | null,
  extra: Partial<MensagemChatwoot> = {},
): MensagemChatwoot {
  return { id, message_type: tipo, content, ...extra };
}

describe("montagem do contexto da conversa", () => {
  it("agrupa as mensagens picotadas do cliente numa entrada só", () => {
    // O caso que motiva o debounce: três linhas seguidas viram uma pergunta.
    const c = montarContexto([
      msg(1, 0, "oi"),
      msg(2, 1, "Olá! Como posso ajudar?"),
      msg(3, 0, "queria saber"),
      msg(4, 0, "sobre sala para 4 pessoas"),
      msg(5, 0, "para amanhã"),
    ]);

    expect(c).not.toBeNull();
    expect(c!.mensagem).toBe("queria saber\nsobre sala para 4 pessoas\npara amanhã");
    expect(c!.historico).toEqual([
      { role: "user", content: "oi" },
      { role: "assistant", content: "Olá! Como posso ajudar?" },
    ]);
  });

  it("mapeia entrada como user e saída como assistant", () => {
    const c = montarContexto([
      msg(1, 0, "primeira"),
      msg(2, 1, "resposta"),
      msg(3, 0, "segunda"),
    ]);

    expect(c!.historico.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(c!.mensagem).toBe("segunda");
  });

  it("devolve null quando a última mensagem é do bot", () => {
    // Nada novo do cliente: responder de novo seria falar sozinho.
    expect(
      montarContexto([msg(1, 0, "oi"), msg(2, 1, "Olá!")]),
    ).toBeNull();
  });

  it("ignora notas privadas da equipe", () => {
    const c = montarContexto([
      msg(1, 0, "oi"),
      msg(2, 1, "combinar desconto?", { private: true }),
      msg(3, 0, "tem desconto?"),
    ]);

    // A nota privada some, e sem ela nenhuma das duas mensagens do cliente foi
    // respondida ainda — então as duas são a entrada nova, não histórico.
    expect(c!.historico).toEqual([]);
    expect(c!.mensagem).toBe("oi\ntem desconto?");
  });

  it("nota privada não é confundida com resposta do bot", () => {
    const c = montarContexto([
      msg(1, 0, "oi"),
      msg(2, 1, "Olá! Como ajudo?"),
      msg(3, 1, "cliente é do plano fixo", { private: true }),
      msg(4, 0, "tem desconto?"),
    ]);

    expect(c!.historico).toEqual([
      { role: "user", content: "oi" },
      { role: "assistant", content: "Olá! Como ajudo?" },
    ]);
    expect(c!.mensagem).toBe("tem desconto?");
  });

  it("ignora eventos de atividade e templates", () => {
    const c = montarContexto([
      msg(1, 2, "Conversa foi resolvida por Ana"),
      msg(2, 3, "template qualquer"),
      msg(3, 0, "voltei"),
    ]);

    expect(c!.historico).toEqual([]);
    expect(c!.mensagem).toBe("voltei");
  });

  it("ignora mensagens vazias (anexo sem texto)", () => {
    const c = montarContexto([
      msg(1, 0, "  "),
      msg(2, 0, null),
      msg(3, 0, "agora com texto"),
    ]);

    expect(c!.mensagem).toBe("agora com texto");
  });

  it("devolve null quando não há nada aproveitável", () => {
    expect(montarContexto([])).toBeNull();
    expect(montarContexto([msg(1, 2, "atividade")])).toBeNull();
  });

  it("limita o histórico para não encarecer cada resposta", () => {
    const muitas: MensagemChatwoot[] = [];
    for (let i = 0; i < 100; i++) {
      muitas.push(msg(i * 2, 0, `pergunta ${i}`));
      muitas.push(msg(i * 2 + 1, 1, `resposta ${i}`));
    }
    muitas.push(msg(999, 0, "última"));

    const c = montarContexto(muitas);

    expect(c!.historico).toHaveLength(30);
    // Mantém as mais recentes, não as mais antigas.
    expect(c!.historico.at(-1)).toEqual({
      role: "assistant",
      content: "resposta 99",
    });
    expect(c!.mensagem).toBe("última");
  });
});
