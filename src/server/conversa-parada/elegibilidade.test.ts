import { describe, expect, it } from "vitest";
import type { MensagemDoCiclo } from "@/server/conversa-encerrada/ciclo";
import {
  passaNoPreFiltro,
  temConversaDeVerdade,
  ultimaMensagemPublica,
  vereditoDaConversa,
  type ConversaDaVarredura,
} from "./elegibilidade";

const AGORA = 1_789_650_000;
const HORA = 3600;

let proximoId = 1;
function msg(parcial: Partial<MensagemDoCiclo> = {}): MensagemDoCiclo {
  return {
    id: proximoId++,
    content: "texto qualquer que é maior que uma saudação",
    message_type: 0,
    created_at: AGORA - 48 * HORA,
    ...parcial,
  };
}

function conversa(parcial: Partial<ConversaDaVarredura> = {}): ConversaDaVarredura {
  return {
    id: 13993,
    status: "open",
    assigneeId: 7,
    assigneeTipo: "User",
    ultimaMensagem: null,
    ...parcial,
  };
}

/** Um atendimento mínimo que passa: cliente escreveu, pessoa da equipe respondeu. */
function atendimento(created_at = AGORA - 48 * HORA): MensagemDoCiclo[] {
  proximoId = 1;
  return [
    msg({ message_type: 0, content: "quero uma sala privativa para duas pessoas", created_at }),
    msg({
      message_type: 1,
      content: "temos sim, na Ayrton Senna",
      created_at,
      sender: { type: "user", name: "Arthur" },
    }),
  ];
}

describe("passaNoPreFiltro", () => {
  it("descarta o que está claramente ativo, sem gastar uma chamada", () => {
    const c = conversa({
      ultimaMensagem: { id: 100, criadaEm: AGORA - 2 * HORA, privada: false },
    });
    expect(passaNoPreFiltro(c, 24, AGORA)).toBe(false);
  });

  it("deixa passar a parada", () => {
    const c = conversa({
      ultimaMensagem: { id: 100, criadaEm: AGORA - 48 * HORA, privada: false },
    });
    expect(passaNoPreFiltro(c, 24, AGORA)).toBe(true);
  });

  it("⚠ nota privada nossa NÃO descarta: senão comentar esconde a conversa", () => {
    // O caso real: ontem o agente deixou a nota, e ela virou a última mensagem
    // não-atividade. Se contasse, a conversa parada há uma semana sumiria do
    // radar por 24h a cada comentário.
    const c = conversa({
      ultimaMensagem: { id: 101, criadaEm: AGORA - 1 * HORA, privada: true },
    });
    expect(passaNoPreFiltro(c, 24, AGORA)).toBe(true);
  });

  it("sem última mensagem na listagem, deixa o worker decidir", () => {
    expect(passaNoPreFiltro(conversa(), 24, AGORA)).toBe(true);
  });
});

describe("ultimaMensagemPublica", () => {
  it("ignora atividade, template e nota privada", () => {
    proximoId = 1;
    const mensagens = [
      msg({ message_type: 0, content: "oi, tudo bem?", created_at: AGORA - 50 * HORA }),
      msg({ message_type: 1, content: "última pública", created_at: AGORA - 49 * HORA }),
      msg({ message_type: 1, content: "nota do agente", private: true, created_at: AGORA - HORA }),
      msg({ message_type: 2, content: "Conversa atribuída", created_at: AGORA - HORA }),
      msg({ message_type: 3, content: "template", created_at: AGORA - HORA }),
    ];

    expect(ultimaMensagemPublica(mensagens)?.content).toBe("última pública");
  });

  it("sem mensagem pública, devolve nulo", () => {
    proximoId = 1;
    expect(ultimaMensagemPublica([msg({ message_type: 2 })])).toBeNull();
  });
});

describe("temConversaDeVerdade", () => {
  it("só saudação do cliente não é conversa", () => {
    proximoId = 1;
    const mensagens = [
      msg({ message_type: 0, content: "oi" }),
      msg({ message_type: 1, content: "olá!", sender: { type: "user", name: "Arthur" } }),
    ];
    expect(temConversaDeVerdade(mensagens, [])).toBe(false);
  });

  it("cliente falou mas só o robô respondeu: não há vendedor a orientar", () => {
    proximoId = 1;
    const mensagens = [
      msg({ message_type: 0, content: "quero saber o valor da sala privativa" }),
      msg({
        message_type: 1,
        content: "escolha uma opção",
        sender: { type: "agent_bot", name: "Seahub" },
      }),
    ];
    expect(temConversaDeVerdade(mensagens, [])).toBe(false);
  });

  it("⚠ conta de automação não conta como equipe", () => {
    proximoId = 1;
    const mensagens = [
      msg({ message_type: 0, content: "quero saber o valor da sala privativa" }),
      msg({
        message_type: 1,
        content: "obrigado pela avaliação!",
        sender: { type: "user", name: "Basílio" },
      }),
    ];
    // O fluxo do n8n escreve com token de usuário e parece gente — a mesma
    // lista que a conversa encerrada usa.
    expect(temConversaDeVerdade(mensagens, ["basilio"])).toBe(false);
    expect(temConversaDeVerdade(mensagens, [])).toBe(true);
  });

  it("cliente com assunto e pessoa da equipe respondendo é conversa", () => {
    expect(temConversaDeVerdade(atendimento(), [])).toBe(true);
  });
});

describe("vereditoDaConversa", () => {
  const base = {
    horasParadas: 24,
    agoraEmSegundos: AGORA,
    contasDeAutomacao: [] as string[],
  };

  it("aceita conversa aberta, com pessoa dona, parada além do limite", () => {
    expect(
      vereditoDaConversa({ ...base, conversa: conversa(), mensagens: atendimento() }),
    ).toEqual({ entra: true });
  });

  it("⚠ sem pessoa dona não entra: aqui a regra é o inverso do resto do sistema", () => {
    const v = vereditoDaConversa({
      ...base,
      conversa: conversa({ assigneeId: null }),
      mensagens: atendimento(),
    });
    expect(v.entra).toBe(false);
  });

  it("⚠ o nosso próprio robô como dono conta como ninguém", () => {
    // As duas tabelas do Chatwoot colidem em id: quem separa é o assignee_type.
    const v = vereditoDaConversa({
      ...base,
      conversa: conversa({ assigneeId: 4, assigneeTipo: "AgentBot" }),
      mensagens: atendimento(),
    });
    expect(v).toMatchObject({ entra: false });
  });

  it("dono de tipo desconhecido não entra: a dúvida não gasta modelo", () => {
    const v = vereditoDaConversa({
      ...base,
      conversa: conversa({ assigneeTipo: null }),
      mensagens: atendimento(),
    });
    expect(v.entra).toBe(false);
  });

  it("recusa a que ainda está quente, dizendo há quanto tempo", () => {
    const v = vereditoDaConversa({
      ...base,
      conversa: conversa(),
      mensagens: atendimento(AGORA - 3 * HORA),
    });
    expect(v).toMatchObject({ entra: false });
    expect((v as { motivo: string }).motivo).toContain("3.0h");
  });

  it("⚠ a nota privada de ontem não reabre o relógio", () => {
    proximoId = 1;
    const mensagens = [
      ...atendimento(AGORA - 72 * HORA),
      msg({
        message_type: 1,
        content: "Sugestão comercial (automática): retome com o cliente",
        private: true,
        created_at: AGORA - 2 * HORA,
        sender: { type: "agent_bot", name: "Assistente Vendedor" },
      }),
    ];

    expect(vereditoDaConversa({ ...base, conversa: conversa(), mensagens })).toEqual({
      entra: true,
    });
  });

  it("conversa resolvida não entra", () => {
    const v = vereditoDaConversa({
      ...base,
      conversa: conversa({ status: "resolved" }),
      mensagens: atendimento(),
    });
    expect(v.entra).toBe(false);
  });
});
