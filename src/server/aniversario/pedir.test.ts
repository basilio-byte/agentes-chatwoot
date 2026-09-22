import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationProvider, PresenteStatus, RunSource } from "@/generated/prisma/enums";
import type { ToolContext } from "@/server/integrations/types";

/**
 * O pedido do presente de ponta a ponta, com banco, Conexa, Chatwoot e o
 * WhatsApp simulados: o que é conferido antes de registrar, e o que sai.
 */

// Terça-feira, 22/09/2026, 9h em São Paulo.
const AGORA = new Date("2026-09-22T12:00:00Z");
// O mesmo CPF público dos outros testes do Conexa.
const CPF = "792.221.104-04";

type Pedido = Record<string, unknown> & { id: string; status: PresenteStatus };

let pedidos: Pedido[] = [];
let chamadas: string[] = [];
let nascimento: string | null = "1990-09-20";
let empresa = false;
let pessoas: Array<Record<string, unknown>> = [];
let agenda: Array<Record<string, unknown>> = [];
let entregaOk = true;

vi.mock("@/lib/db", () => {
  const presenteDeAniversario = {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      pedidos.find((p) => {
        if (where.clienteId !== undefined && p.clienteId !== where.clienteId) return false;
        const status = where.status as PresenteStatus | { in: PresenteStatus[] } | undefined;
        if (typeof status === "string" && p.status !== status) return false;
        if (status && typeof status === "object" && !status.in.includes(p.status)) return false;
        const conversa = where.chatwootConversationId as number | { not: number } | undefined;
        if (typeof conversa === "number" && p.chatwootConversationId !== conversa) return false;
        if (conversa && typeof conversa === "object" && p.chatwootConversationId === conversa.not) return false;
        return true;
      }) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const p = { id: `p${pedidos.length + 1}`, status: PresenteStatus.AGUARDANDO, criadoEm: AGORA, ...data } as Pedido;
      pedidos.push(p);
      return p;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const alvo = pedidos.filter(
        (p) => p.chatwootConversationId === where.chatwootConversationId && p.status === where.status,
      );
      alvo.forEach((p) => Object.assign(p, data));
      return { count: alvo.length };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const p = pedidos.find((x) => x.id === where.id)!;
      Object.assign(p, data);
      return p;
    },
  };
  return {
    db: {
      presenteDeAniversario,
      $transaction: async (fn: (tx: unknown) => unknown) => fn({ presenteDeAniversario }),
    },
  };
});

vi.mock("@/server/integrations/conexa/sistema", () => ({
  abrirConexa: async () => ({
    config: { baseUrl: "https://conexa.test", unidades: [], salas: [] },
    cliente: {
      obterCliente: async (id: number) => {
        chamadas.push(`conexa:cliente:${id}`);
        return empresa
          ? { name: "Empresa de Teste", legalPerson: { cnpj: "00394460005887" } }
          : { name: "Cliente de Teste", naturalPerson: { cpf: CPF, birthDate: nascimento } };
      },
      listarPessoas: async () => ({ itens: pessoas, temMais: false }),
      listarReservas: async () => ({ itens: agenda, temMais: false }),
    },
    executar: async () => {
      throw new Error("o pedido não reserva nada");
    },
  }),
}));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteDoAgente: async (id: string) => ({
    baseUrl: "https://chatwoot.test",
    contaId: 1,
    enviarMensagem: async (conversa: number, texto: string, opcoes?: { privado?: boolean }) => {
      chamadas.push(`chatwoot:${id}:${opcoes?.privado ? "nota" : "mensagem"}:${conversa}:${texto.slice(0, 40)}`);
      return { id: 1 };
    },
  }),
  clienteComTokenDeUsuario: async () => ({}),
}));

vi.mock("@/server/alerta-de-saldo/conversa", () => ({
  entregarAviso: async (_c: unknown, caixa: number, destinatarios: Array<{ nome: string }>, texto: string) => {
    chamadas.push(`whatsapp:caixa-${caixa}:${texto.split("\n")[0]}`);
    return destinatarios.map((d) => ({
      nome: d.nome,
      ok: entregaOk,
      detalhe: entregaOk ? "entregue ao Chatwoot" : "Chatwoot respondeu 500",
      conversaId: entregaOk ? 700 : null,
    }));
  },
}));

const { pedirPresente } = await import("./pedir");

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    provider: IntegrationProvider.ANIVERSARIO,
    config: { avisar: [{ nome: "Diego", telefone: "+5584999999999" }] },
    credential: null,
    agentId: "salas",
    canalAgentId: "porta",
    source: RunSource.CHATWOOT,
    chatwootConversationId: 99,
    historico: [{ role: "user", content: `recebi o e-mail de aniversário! meu cpf é ${CPF}` }],
    mensagem: "quero a sala na sexta das 14h às 16h",
    ...extra,
  };
}

const pedido = { clienteId: 5872, sala: "2107", nomeDaSala: "Sala 03", data: "2026-09-25", inicio: "14:00", fim: "16:00" };

beforeEach(() => {
  pedidos = [];
  chamadas = [];
  nascimento = "1990-09-20";
  empresa = false;
  pessoas = [];
  agenda = [];
  entregaOk = true;
});

describe("pedir o presente de aniversário", () => {
  it("registra, avisa a equipe por WhatsApp e deixa a nota — sem reservar", async () => {
    const r = await pedirPresente(pedido, ctx(), AGORA);

    expect(r).toMatchObject({ registrado: true });
    expect(String(r.observacao)).toContain("NÃO reserve nem fature");
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]).toMatchObject({
      chatwootConversationId: 99,
      agentId: "salas",
      portaAgentId: "porta",
      clienteId: 5872,
      salaId: 2107,
      salaNome: "Sala 03",
      aniversario: "20/09",
      status: PresenteStatus.AGUARDANDO,
    });
    // 4 h de prazo: a reserva é na sexta.
    expect((pedidos[0].venceEm as Date).getTime()).toBe(AGORA.getTime() + 4 * 3_600_000);
    expect(chamadas).toContain("whatsapp:caixa-31:🎂 Pedido de presente de aniversário");
    expect(chamadas.some((c) => c.startsWith("chatwoot:porta:nota:99:🎂 Presente de aniversário pedido"))).toBe(true);
    // Nada foi dito ao cliente pelo sistema: quem responde é o agente.
    expect(chamadas.some((c) => c.includes(":mensagem:"))).toBe(false);
  });

  it("⚠ sem o documento numa fala do cliente, não lê o aniversário nem registra", async () => {
    const r = await pedirPresente(pedido, ctx({ historico: [{ role: "user", content: "oi, é meu aniversário" }] }), AGORA);
    expect(r.registrado).toBe(false);
    expect(pedidos).toHaveLength(0);
    expect(chamadas.some((c) => c.startsWith("whatsapp"))).toBe(false);
  });

  it("o documento que o ROBÔ escreveu não prova nada", async () => {
    const r = await pedirPresente(
      pedido,
      ctx({ historico: [{ role: "assistant", content: `o CPF cadastrado é ${CPF}` }], mensagem: "isso" }),
      AGORA,
    );
    expect(r.registrado).toBe(false);
    expect(pedidos).toHaveLength(0);
  });

  it("aniversário fora da janela: recusa sem contar a data do cadastro", async () => {
    nascimento = "1990-03-10";
    const r = await pedirPresente(pedido, ctx(), AGORA);
    expect(r.registrado).toBe(false);
    expect(String(r.erro)).toContain("até 7 dias depois");
    expect(JSON.stringify(r)).not.toContain("10/03");
    expect(JSON.stringify(r)).not.toContain("1990");
    expect(pedidos).toHaveLength(0);
  });

  it("sem data de nascimento no cadastro: manda passar para a equipe", async () => {
    nascimento = null;
    const r = await pedirPresente(pedido, ctx(), AGORA);
    expect(r.registrado).toBe(false);
    expect(String(r.comoSeguir)).toContain("Passe a conversa");
  });

  it("empresa: vale o aniversário de quem provou com o PRÓPRIO CPF, e só o dele", async () => {
    empresa = true;
    pessoas = [
      { personId: 10, name: "Outra pessoa", cpf: "11144477735", birthDate: "1980-09-21" },
      { personId: 11, name: "Quem pediu", cpf: CPF.replace(/\D/g, ""), birthDate: "1990-01-01" },
    ];
    // A pessoa 11 provou, e o aniversário dela não está na janela — o da
    // pessoa 10 não conta por ela.
    expect((await pedirPresente(pedido, ctx(), AGORA)).registrado).toBe(false);

    pessoas[1].birthDate = "1990-09-19";
    const r = await pedirPresente(pedido, ctx(), AGORA);
    expect(r.registrado).toBe(true);
    expect(pedidos[0]).toMatchObject({ pessoaId: 11, aniversario: "19/09" });
  });

  it("mais de 2 h, ou começando em menos de 1 h: não registra", async () => {
    expect((await pedirPresente({ ...pedido, fim: "17:00" }, ctx(), AGORA)).registrado).toBe(false);
    expect(
      (await pedirPresente({ ...pedido, data: "2026-09-22", inicio: "09:30", fim: "11:00" }, ctx(), AGORA)).registrado,
    ).toBe(false);
    expect(pedidos).toHaveLength(0);
  });

  it("horário ocupado: não registra nem avisa ninguém, e diz o que ocupa", async () => {
    agenda = [{ bookingId: 1, customerId: 1, startTime: "2026-09-25T15:00:00-03:00", finalTime: "2026-09-25T16:00:00-03:00", status: "notBilled" }];
    const r = await pedirPresente(pedido, ctx(), AGORA);
    expect(r.registrado).toBe(false);
    expect(r.ocupado).toEqual([{ inicio: "2026-09-25T15:00:00-03:00", fim: "2026-09-25T16:00:00-03:00" }]);
    expect(pedidos).toHaveLength(0);
    expect(chamadas.some((c) => c.startsWith("whatsapp"))).toBe(false);
  });

  it("já usou o presente este ano: não registra outro", async () => {
    pedidos.push({ id: "antigo", status: PresenteStatus.RESERVADO, clienteId: 5872, chatwootConversationId: 50, data: "2026-01-10", criadoEm: new Date("2026-01-09T12:00:00Z") });
    const r = await pedirPresente(pedido, ctx(), AGORA);
    expect(r.registrado).toBe(false);
    expect(String(r.erro)).toContain("10/01/2026");
  });

  it("pedir de novo na mesma conversa troca o horário", async () => {
    await pedirPresente(pedido, ctx(), AGORA);
    await pedirPresente({ ...pedido, inicio: "15:00", fim: "17:00" }, ctx(), AGORA);
    expect(pedidos.map((p) => p.status)).toEqual([PresenteStatus.CANCELADO, PresenteStatus.AGUARDANDO]);
    expect(pedidos[1].inicio).toBe("15:00");
  });

  it("pedido do mesmo cliente em OUTRA conversa: não registra de novo", async () => {
    await pedirPresente(pedido, ctx(), AGORA);
    const r = await pedirPresente(pedido, ctx({ chatwootConversationId: 100 }), AGORA);
    expect(r.registrado).toBe(false);
    expect(pedidos).toHaveLength(1);
  });

  it("WhatsApp que não sai: o pedido não fica esperando um pacote que ninguém vai lançar", async () => {
    entregaOk = false;
    const r = await pedirPresente(pedido, ctx(), AGORA);
    expect(r.registrado).toBe(false);
    expect(String(r.comoSeguir)).toContain("Passe a conversa");
    expect(pedidos[0].status).toBe(PresenteStatus.FALHOU);
  });

  it("sem ninguém cadastrado para o aviso: nem começa", async () => {
    const r = await pedirPresente(pedido, ctx({ config: {} }), AGORA);
    expect(r.registrado).toBe(false);
    expect(chamadas).toHaveLength(0);
  });

  it("no playground confere tudo e não registra nada", async () => {
    const r = await pedirPresente(pedido, ctx({ source: RunSource.PLAYGROUND, chatwootConversationId: undefined }), AGORA);
    expect(r).toMatchObject({ registrado: false, simulacao: true });
    expect(pedidos).toHaveLength(0);
    expect(chamadas.some((c) => c.startsWith("whatsapp"))).toBe(false);
  });

  it("fora de um atendimento (gatilho, agendamento), recusa", async () => {
    const r = await pedirPresente(pedido, ctx({ source: RunSource.TRIGGER, chatwootConversationId: undefined }), AGORA);
    expect(r.registrado).toBe(false);
    expect(chamadas).toHaveLength(0);
  });
});
