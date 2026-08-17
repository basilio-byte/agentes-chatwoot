import { beforeEach, describe, expect, it } from "vitest";
import type { ChatwootClient } from "./client";
import { donoEhHumano, ehHumano, limparCacheDeHumanos } from "./humanos";

/**
 * Quem é gente na conta decide se o bot cala ou fala. Errar para um lado faz o
 * bot atropelar um atendente de verdade; errar para o outro faz a conversa
 * ficar muda para sempre.
 */

let chamadas: number;
let equipe: Array<{ id: number; name?: string }>;
let falhar: boolean;

/** Só o que `humanos.ts` usa do cliente. */
function clienteFalso(contaId = 1): ChatwootClient {
  return {
    contaId,
    listarAtendentes: async () => {
      chamadas++;
      if (falhar) throw new Error("Chatwoot fora do ar");
      return equipe;
    },
  } as unknown as ChatwootClient;
}

beforeEach(() => {
  limparCacheDeHumanos();
  chamadas = 0;
  falhar = false;
  equipe = [
    { id: 1, name: "Ana" },
    { id: 2, name: "Bruno" },
  ];
});

describe("quem é gente", () => {
  it("reconhece quem está na lista de agentes", async () => {
    expect(await ehHumano(clienteFalso(), 1)).toBe(true);
  });

  it("recusa quem não está — é o caso do próprio Agent Bot", async () => {
    expect(await ehHumano(clienteFalso(), 99)).toBe(false);
  });

  it("sem dono, não há o que responder", async () => {
    expect(await ehHumano(clienteFalso(), null)).toBeNull();
    expect(await ehHumano(clienteFalso(), undefined)).toBeNull();
    expect(chamadas).toBe(0); // e nem custa uma requisição
  });
});

describe("cache", () => {
  it("não repete a consulta para quem já é conhecido", async () => {
    const cliente = clienteFalso();

    for (let i = 0; i < 5; i++) expect(await ehHumano(cliente, 1)).toBe(true);

    expect(chamadas).toBe(1);
  });

  it("contas diferentes não compartilham lista", async () => {
    await ehHumano(clienteFalso(1), 1);
    await ehHumano(clienteFalso(2), 1);

    expect(chamadas).toBe(2);
  });

  /**
   * A trava que protege um atendente recém-contratado: um "não" nunca sai do
   * cache sozinho. Sem esta releitura, quem entrasse na equipe seria
   * classificado como não-humano por até cinco minutos — e o bot falaria por
   * cima dele justamente no primeiro atendimento.
   */
  it("relê ao vivo antes de concluir que alguém NÃO é gente", async () => {
    const cliente = clienteFalso();

    expect(await ehHumano(cliente, 1)).toBe(true); // aquece o cache
    expect(chamadas).toBe(1);

    equipe = [...equipe, { id: 3, name: "Carla (nova)" }];

    expect(await ehHumano(cliente, 3)).toBe(true);
    expect(chamadas).toBe(2); // releu em vez de confiar no cache velho
  });
});

describe("quando não dá para saber", () => {
  it("devolve null em vez de chutar", async () => {
    falhar = true;
    expect(await ehHumano(clienteFalso(), 7)).toBeNull();
  });

  it("null vira `undefined` para a regra global — que então cala", async () => {
    // É a suposição segura: falar por cima de um atendente de verdade é pior
    // que ficar quieto.
    falhar = true;
    expect(await donoEhHumano(clienteFalso(), 7)).toBeUndefined();
  });

  it("sem dono também é `undefined`, não `false`", async () => {
    expect(await donoEhHumano(clienteFalso(), null)).toBeUndefined();
  });

  it("dono que não é gente chega como `false`", async () => {
    expect(await donoEhHumano(clienteFalso(), 99)).toBe(false);
  });
});
