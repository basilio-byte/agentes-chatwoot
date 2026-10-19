import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaminhoDoRepasse, ConversationStatus } from "@/generated/prisma/enums";

/**
 * O histórico de repasses a pessoas (`RepasseParaPessoa`) é lido pelo contrato
 * de métricas. Ele nasce dentro de `entregarAoHumano`, a única porta para o
 * estado `HUMAN`, e não pode atrapalhar a entrega.
 */

type Conversa = { id: string; status: ConversationStatus; agentId: string | null };

let conversas: Conversa[] = [];
let repasses: Record<string, unknown>[] = [];
let falharRepasse = false;
let atualizacoes = 0;

vi.mock("@/lib/db", () => ({
  db: {
    conversation: {
      findMany: async () => conversas.map((c) => ({ ...c })),
      updateMany: async ({ data }: { data: { status: ConversationStatus } }) => {
        atualizacoes++;
        conversas = conversas.map((c) => ({ ...c, status: data.status }));
        return { count: conversas.length };
      },
    },
    repasseParaPessoa: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        if (falharRepasse) throw new Error("banco fora do ar");
        repasses.push(...data);
        return { count: data.length };
      },
    },
  },
}));

const { contaComoRepasse, entregarAoHumano } = await import("./resolucao");

beforeEach(() => {
  conversas = [{ id: "c1", status: ConversationStatus.BOT, agentId: "agente-salas" }];
  repasses = [];
  falharRepasse = false;
  atualizacoes = 0;
});

describe("quando a entrega a uma pessoa vira evento", () => {
  it("a conversa do robô que passa para uma pessoa conta", () => {
    expect(contaComoRepasse(ConversationStatus.BOT, CaminhoDoRepasse.RODIZIO)).toBe(true);
    expect(contaComoRepasse(ConversationStatus.CLOSED, CaminhoDoRepasse.PESSOA_ASSUMIU)).toBe(true);
  });

  it("a que já estava com uma pessoa não conta de novo", () => {
    // O webhook de conta reafirma "uma pessoa assumiu" a cada atualização.
    expect(contaComoRepasse(ConversationStatus.HUMAN, CaminhoDoRepasse.PESSOA_ASSUMIU)).toBe(false);
    expect(contaComoRepasse(ConversationStatus.HUMAN, CaminhoDoRepasse.VIGIA_DE_ESPERA)).toBe(false);
  });

  it("o prazo vencido conta mesmo com uma pessoa: passa para OUTRA", () => {
    expect(contaComoRepasse(ConversationStatus.HUMAN, CaminhoDoRepasse.PRAZO_VENCIDO)).toBe(true);
  });
});

describe("entregarAoHumano grava o repasse", () => {
  it("com o caminho, a conversa e o agente que estava com ela", async () => {
    await entregarAoHumano(42, "rodízio salas → Kelly: quer fechar", CaminhoDoRepasse.RODIZIO);

    expect(conversas[0].status).toBe(ConversationStatus.HUMAN);
    expect(repasses).toEqual([
      {
        conversationId: "c1",
        chatwootConversationId: 42,
        agentId: "agente-salas",
        caminho: CaminhoDoRepasse.RODIZIO,
      },
    ]);
  });

  it("o motivo em texto NÃO vai para o evento (cita nomes de funcionários)", async () => {
    await entregarAoHumano(42, "atribuído a Kelly: cliente pediu", CaminhoDoRepasse.ATRIBUICAO_DIRETA);
    expect(JSON.stringify(repasses)).not.toContain("Kelly");
  });

  it("sem caminho, entrega e não grava evento", async () => {
    await entregarAoHumano(42, "conversa em status snoozed", null);
    expect(conversas[0].status).toBe(ConversationStatus.HUMAN);
    expect(repasses).toEqual([]);
  });

  it("a segunda entrega da mesma conversa não repete o evento", async () => {
    await entregarAoHumano(42, "conversa atribuída a um humano", CaminhoDoRepasse.PESSOA_ASSUMIU);
    await entregarAoHumano(42, "conversa atribuída a um humano", CaminhoDoRepasse.PESSOA_ASSUMIU);
    expect(repasses).toHaveLength(1);
    expect(atualizacoes).toBe(2);
  });

  it("falha ao gravar o evento não impede a entrega", async () => {
    falharRepasse = true;
    await expect(
      entregarAoHumano(42, "vigia: cliente esperou mais de 3 min", CaminhoDoRepasse.VIGIA_DE_ESPERA),
    ).resolves.toBeUndefined();
    expect(conversas[0].status).toBe(ConversationStatus.HUMAN);
  });

  it("conversa que o sistema não conhece não gera evento", async () => {
    conversas = [];
    await entregarAoHumano(99, "rodízio", CaminhoDoRepasse.RODIZIO);
    expect(repasses).toEqual([]);
  });
});
