import { beforeEach, describe, expect, it, vi } from "vitest";

/** A leitura do contato da conversa para a task do CRM: nunca lança e nunca adivinha. */

let leituras: string[] = [];
let falhar = false;
let semCliente = false;

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteDoAgente: async (agentId: string) => {
    leituras.push(`cliente:${agentId}`);
    if (semCliente) return null;
    return {
      obterConversa: async (id: number) => {
        leituras.push(`conversa:${id}`);
        if (falhar) throw new Error("Chatwoot respondeu 500");
        return { contactId: 9 };
      },
      obterContato: async (id: number) => {
        leituras.push(`contato:${id}`);
        return { atributos: { canal: "Redes sociais", qualificao: "5" } };
      },
    };
  },
}));

import { atributosDoContatoDaConversa } from "./espelho";

beforeEach(() => {
  leituras = [];
  falhar = false;
  semCliente = false;
});

describe("atributosDoContatoDaConversa", () => {
  it("lê o contato da conversa pelo robô da caixa", async () => {
    expect(
      await atributosDoContatoDaConversa({ chatwootConversationId: 14592, canalAgentId: "porta", agentId: "crm" }),
    ).toEqual({ canal: "Redes sociais", qualificao: "5" });
    expect(leituras).toEqual(["cliente:porta", "conversa:14592", "contato:9"]);
  });

  it("sem conversa, não lê nada", async () => {
    expect(await atributosDoContatoDaConversa({ agentId: "crm" })).toEqual({});
    expect(leituras).toEqual([]);
  });

  it("falha do Chatwoot ou agente sem cliente: devolve vazio, sem lançar", async () => {
    falhar = true;
    expect(await atributosDoContatoDaConversa({ chatwootConversationId: 1, agentId: "crm" })).toEqual({});
    semCliente = true;
    expect(await atributosDoContatoDaConversa({ chatwootConversationId: 1, agentId: "crm" })).toEqual({});
  });
});
