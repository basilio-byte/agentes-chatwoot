import { describe, expect, it } from "vitest";
import { montarContexto } from "./historico";
import type { MensagemChatwoot } from "./client";

/** `created_at` do Chatwoot vem em segundos. */
const seg = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function msg(
  id: number,
  tipo: 0 | 1,
  content: string,
  iso?: string,
): MensagemChatwoot {
  return {
    id,
    message_type: tipo,
    content,
    ...(iso ? { created_at: seg(iso) } : {}),
  };
}

describe("corte de histórico ao resolver", () => {
  const conversa = [
    msg(1, 0, "quero alugar sala", "2026-07-01T10:00:00Z"),
    msg(2, 1, "temos disponível", "2026-07-01T10:01:00Z"),
    msg(3, 0, "obrigado", "2026-07-01T10:02:00Z"),
    msg(4, 1, "de nada!", "2026-07-01T10:03:00Z"),
    // --- resolvida aqui, 2026-07-10 ---
    msg(5, 0, "agora quero cancelar meu plano", "2026-07-20T09:00:00Z"),
  ];

  it("sem corte, o agente vê a conversa inteira", () => {
    const c = montarContexto(conversa);

    expect(c!.historico).toHaveLength(4);
    expect(c!.mensagem).toBe("agora quero cancelar meu plano");
  });

  it("com corte, o assunto antigo some — reabriu, começa do zero", () => {
    const c = montarContexto(conversa, new Date("2026-07-10T00:00:00Z"));

    // É o ponto do pedido: o cliente volta por outro motivo, e arrastar o
    // contexto de aluguel faria o agente responder a pergunta errada.
    expect(c!.historico).toEqual([]);
    expect(c!.mensagem).toBe("agora quero cancelar meu plano");
  });

  it("mantém o que veio depois do corte", () => {
    const depois = [
      ...conversa,
      msg(5, 1, "vou verificar seu contrato", "2026-07-20T09:01:00Z"),
      msg(6, 0, "quanto tempo demora?", "2026-07-20T09:02:00Z"),
    ];

    const c = montarContexto(depois, new Date("2026-07-10T00:00:00Z"));

    expect(c!.historico).toEqual([
      { role: "user", content: "agora quero cancelar meu plano" },
      { role: "assistant", content: "vou verificar seu contrato" },
    ]);
    expect(c!.mensagem).toBe("quanto tempo demora?");
  });

  it("corte no futuro descarta tudo e não sobra o que responder", () => {
    expect(montarContexto(conversa, new Date("2027-01-01T00:00:00Z"))).toBeNull();
  });

  it("mensagem sem data é mantida — perder contexto é pior que uma linha a mais", () => {
    const semData = [
      msg(1, 0, "antiga sem data"),
      msg(2, 0, "nova", "2026-07-20T09:00:00Z"),
    ];

    const c = montarContexto(semData, new Date("2026-07-10T00:00:00Z"));
    expect(c!.mensagem).toBe("antiga sem data\nnova");
  });
});
