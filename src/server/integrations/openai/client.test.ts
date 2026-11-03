import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import {
  MAX_TOKENS_DESCRICAO,
  MAX_TOKENS_LEITURA_COMPLETA,
  descreverImagem,
  lerDocumento,
} from "./client";

/**
 * O teto de saída da leitura e o sinal de que a leitura bateu nele.
 *
 * Achado em 02/11/2026: a conta de energia do Drive era lida com 900 tokens e
 * voltava cortada no meio da tabela de itens, sem nada que a distinguisse de uma
 * leitura inteira. O que o modelo recebe é `finish_reason`; sem lê-lo, o corte é
 * invisível.
 */

type Pedido = { max_completion_tokens?: number };

function clienteFalso(finishReason: string, texto = "texto lido") {
  const pedidos: Pedido[] = [];
  const cliente = {
    chat: {
      completions: {
        create: async (pedido: Pedido) => {
          pedidos.push(pedido);
          return {
            choices: [{ message: { content: texto }, finish_reason: finishReason }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          };
        },
      },
    },
  } as unknown as OpenAI;
  return { cliente, pedidos };
}

const arquivo = { bytes: Buffer.from("pdf"), mimeType: "application/pdf", tamanhoBytes: 3 };

describe("teto de saída da leitura", () => {
  it("o padrão do atendimento continua em 900 tokens", async () => {
    const { cliente, pedidos } = clienteFalso("stop");

    await lerDocumento({ cliente, arquivo, nome: "a.pdf", model: "m", instrucao: "x" });
    await descreverImagem({ cliente, arquivo, model: "m", instrucao: "x" });

    expect(MAX_TOKENS_DESCRICAO).toBe(900);
    expect(pedidos.map((p) => p.max_completion_tokens)).toEqual([900, 900]);
  });

  it("quem pede teto maior o recebe — nos dois endpoints", async () => {
    const { cliente, pedidos } = clienteFalso("stop");

    await lerDocumento({
      cliente,
      arquivo,
      nome: "a.pdf",
      model: "m",
      instrucao: "x",
      maxTokens: MAX_TOKENS_LEITURA_COMPLETA,
    });
    await descreverImagem({
      cliente,
      arquivo,
      model: "m",
      instrucao: "x",
      maxTokens: MAX_TOKENS_LEITURA_COMPLETA,
    });

    expect(pedidos.map((p) => p.max_completion_tokens)).toEqual([4000, 4000]);
  });

  it("a leitura do Drive tem folga sobre a do atendimento", () => {
    // A DANFE de tarifa branca gasta os 900 antes do medidor; o teto novo tem
    // de ser bem maior, não um ajuste de fachada.
    expect(MAX_TOKENS_LEITURA_COMPLETA).toBeGreaterThanOrEqual(MAX_TOKENS_DESCRICAO * 4);
  });
});

describe("finish_reason: length é leitura cortada", () => {
  it("documento que parou no teto volta marcado como cortado", async () => {
    const { cliente } = clienteFalso("length", "ITENS DA FATURA … G2Comp.oUC-Ma-NP-TE");

    const r = await lerDocumento({ cliente, arquivo, nome: "a.pdf", model: "m", instrucao: "x" });

    expect(r.cortado).toBe(true);
    expect(r.texto).toBe("ITENS DA FATURA … G2Comp.oUC-Ma-NP-TE");
  });

  it("imagem que parou no teto também", async () => {
    const { cliente } = clienteFalso("length");

    const r = await descreverImagem({ cliente, arquivo, model: "m", instrucao: "x" });

    expect(r.cortado).toBe(true);
  });

  it("leitura que terminou sozinha não é cortada", async () => {
    const { cliente } = clienteFalso("stop");

    const doc = await lerDocumento({ cliente, arquivo, nome: "a.pdf", model: "m", instrucao: "x" });
    const img = await descreverImagem({ cliente, arquivo, model: "m", instrucao: "x" });

    expect(doc.cortado).toBe(false);
    expect(img.cortado).toBe(false);
  });
});
