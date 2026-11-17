import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rodada do follow-up de reserva de ponta a ponta, com banco, Conexa e Chatwoot
 * simulados. O caso é o da conversa 11708 (16/11/2026): reserva das 17h feita às
 * 10h02 pelo agente de Salas, faturada em R$ 70, sem pagamento.
 */

const sp = (texto: string) => new Date(`${texto}:00-03:00`);
const CRIADA = sp("2026-11-16T10:02");
const NA_HORA = sp("2026-11-16T14:05");
const LINK = "https://seahubcoworking.conexa.app/index.php?r=cobranca/fatura&id=eb6b";

type Evento = {
  id: string;
  provider: string;
  externalId: string;
  resultado: string | null;
  detalhe?: string | null;
  createdAt: Date;
};

let integracao: { enabled: boolean; config: unknown } | null;
let eventos: Evento[];
let reservaNoConexa: Record<string, unknown>;
let cobrancaNoConexa: Record<string, unknown>;
let conversa: Record<string, unknown>;
let mensagens: Array<Record<string, unknown>>;
let enviadas: Array<{ conversa: number; texto: string; privado: boolean }>;
let falharEnvio: Error | null;
let leiturasNoConexa: number;

const segundos = (d: Date) => Math.floor(d.getTime() / 1000);

vi.mock("@/lib/db", () => ({
  db: {
    integration: { findUnique: async () => integracao },
    toolCall: {
      findMany: async () => {
        const run = {
          agentId: "agente-salas",
          conversationId: "conv-local",
          conversation: { chatwootConversationId: 11708, chatwootInboxId: 29 },
        };
        return [
          {
            toolName: "conexa_criar_reserva",
            input: {},
            output: {
              criada: true,
              reserva: { id: 30500, inicio: "2026-11-16T17:00:00-03:00", fim: "2026-11-16T18:00:00-03:00" },
            },
            createdAt: CRIADA,
            run,
          },
          {
            toolName: "conexa_faturar_reserva",
            input: { reservaId: 30500 },
            output: { faturada: true, cobranca: { id: 33171, faturaUrl: LINK, valorAtual: 70 } },
            createdAt: CRIADA,
            run,
          },
        ];
      },
    },
    webhookEvent: {
      findMany: async ({ where }: { where: { externalId: { in: string[] }; resultado: { not: string } } }) =>
        eventos.filter(
          (e) => where.externalId.in.includes(e.externalId) && e.resultado !== where.resultado.not,
        ),
      findUnique: async ({ where }: { where: { provider_externalId: { externalId: string } } }) =>
        eventos.find((e) => e.externalId === where.provider_externalId.externalId) ?? null,
      create: async ({ data }: { data: Omit<Evento, "id" | "createdAt"> }) => {
        if (eventos.some((e) => e.externalId === data.externalId)) {
          throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        }
        const e = { ...data, id: `ev-${eventos.length + 1}`, createdAt: new Date() } as Evento;
        eventos.push(e);
        return { id: e.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Evento> }) => {
        const e = eventos.find((x) => x.id === where.id)!;
        Object.assign(e, data);
        return e;
      },
    },
  },
}));

vi.mock("@/server/integrations/conexa/sistema", () => ({
  abrirConexa: async () => ({
    cliente: {
      obterReserva: async () => {
        leiturasNoConexa++;
        return reservaNoConexa;
      },
      obterCobranca: async () => cobrancaNoConexa,
    },
  }),
}));

vi.mock("@/server/integrations/chatwoot/porta", () => ({ portaDaCaixa: async () => "porta-29" }));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteDoAgente: async () => ({
    obterConversa: async () => conversa,
    listarMensagens: async () => mensagens,
    obterContato: async () => ({ nome: "Diego Mendonça" }),
    enviarMensagem: async (id: number, texto: string, opcoes?: { privado?: boolean }) => {
      if (falharEnvio && !opcoes?.privado) throw falharEnvio;
      enviadas.push({ conversa: id, texto, privado: !!opcoes?.privado });
      return { id: 1 };
    },
  }),
}));

const { conferirFollowupsDeReserva, reiniciarRelogioDoFollowup } = await import("./conferir");
const { ChatwootApiError } = await import("@/server/integrations/chatwoot/client");

const rodar = (agora = NA_HORA) => conferirFollowupsDeReserva(agora, { esperar: true, forcar: true });
const aoCliente = () => enviadas.filter((m) => !m.privado);
const notas = () => enviadas.filter((m) => m.privado);

beforeEach(() => {
  reiniciarRelogioDoFollowup();
  integracao = { enabled: true, config: { modo: "ligado" } };
  eventos = [];
  reservaNoConexa = {
    status: "billed",
    startTime: "2026-11-16T17:00:00-03:00",
    finalTime: "2026-11-16T18:00:00-03:00",
    place: { id: 2105, name: "[SEAWAY] - SALA DE REUNIÃO 01 - 10 pessoas" },
  };
  cobrancaNoConexa = { chargeId: 33171, status: "unpaid", currentAmount: 70, amount: 70, chargeUrl: LINK };
  conversa = { status: "resolved", assigneeId: null, assigneeTipo: null, contactId: 77, inboxId: 29 };
  mensagens = [
    { id: 823392, message_type: 0, content: "Sim", created_at: segundos(CRIADA) },
    { id: 823398, message_type: 1, content: "confirmação", created_at: segundos(CRIADA) + 60 },
  ];
  enviadas = [];
  falharEnvio = null;
  leiturasNoConexa = 0;
});

describe("follow-up de reserva — ligado", () => {
  it("reserva não paga na hora: UMA mensagem ao cliente com sala, horário, valor e link, mais a nota interna", async () => {
    const r = await rodar();

    expect(r.enviados).toEqual([30500]);
    expect(aoCliente()).toHaveLength(1);
    const texto = aoCliente()[0].texto;
    expect(texto).toContain("Oi, Diego!");
    expect(texto).toContain("Sala de Reunião 01 (Seaway)");
    expect(texto).toContain("hoje, 16/11, das 17h às 18h");
    expect(texto).toContain("R$ 70,00");
    expect(texto).toContain(LINK);
    expect(notas()[0].texto).toMatch(/^🤖 Follow-up de reserva \(automático\): a reserva 30500/);
    expect(eventos).toEqual([
      expect.objectContaining({ externalId: "reserva:30500", resultado: "enviado" }),
    ]);

    // A rodada seguinte não manda de novo.
    await rodar(new Date(NA_HORA.getTime() + 5 * 60_000));
    expect(aoCliente()).toHaveLength(1);
  });

  it("antes da hora não abre o Conexa nem fala com ninguém", async () => {
    const r = await rodar(sp("2026-11-16T13:00"));
    expect(r.candidatos).toBe(1);
    expect(leiturasNoConexa).toBe(0);
    expect(enviadas).toEqual([]);
    expect(eventos).toEqual([]);
  });

  it("reserva paga: nada ao cliente, desfecho registrado", async () => {
    reservaNoConexa = { ...reservaNoConexa, status: "paid" };
    const r = await rodar();
    expect(enviadas).toEqual([]);
    expect(r.semFollowup).toEqual(["30500: a reserva está paga"]);
    expect(eventos[0]).toMatchObject({ resultado: "sem follow-up", detalhe: "a reserva está paga" });
  });

  it("cobrança paga (a reserva ainda não virou): nada ao cliente", async () => {
    cobrancaNoConexa = { ...cobrancaNoConexa, status: "paid" };
    await rodar();
    expect(enviadas).toEqual([]);
    expect(eventos[0]).toMatchObject({ resultado: "sem follow-up", detalhe: "a cobrança está paga" });
  });

  it("descontada do pacote ou cancelada: nada ao cliente", async () => {
    reservaNoConexa = { ...reservaNoConexa, status: "deductedFromQuota" };
    await rodar();
    expect(enviadas).toEqual([]);
    expect(eventos[0].detalhe).toBe("descontada do pacote de horas");
  });

  it("uma pessoa da equipe está com a conversa: nota para ela, NADA ao cliente", async () => {
    conversa = { ...conversa, status: "open", assigneeId: 21, assigneeTipo: "User", assigneeNome: "Wellen Kelly" };
    const r = await rodar();
    expect(aoCliente()).toEqual([]);
    expect(notas()[0].texto).toMatch(/^📌 Follow-up de reserva: a reserva 30500/);
    expect(r.notas).toEqual([30500]);
    expect(eventos[0]).toMatchObject({ resultado: "nota" });
  });

  it("o cliente está esperando resposta do robô: espera a rodada seguinte, sem registrar desfecho", async () => {
    conversa = { ...conversa, status: "open" };
    mensagens.push({ id: 823500, message_type: 0, content: "oi", created_at: segundos(NA_HORA) - 60 });
    const r = await rodar();
    expect(enviadas).toEqual([]);
    expect(eventos).toEqual([]);
    expect(r.aguardando?.[0]).toMatch(/^30500: /);
  });

  it("o Chatwoot falha sem resposta clara: fica INCERTO e nunca é reenviado", async () => {
    falharEnvio = new Error("socket hang up");
    const r = await rodar();
    expect(r.incertos).toEqual([30500]);
    expect(eventos[0]).toMatchObject({ resultado: "incerto" });

    falharEnvio = null;
    await rodar(new Date(NA_HORA.getTime() + 5 * 60_000));
    expect(aoCliente()).toEqual([]);
  });

  it("o Chatwoot recusa com 4xx: registra a falha, sem nota de envio", async () => {
    falharEnvio = new ChatwootApiError(422, "conversa inválida");
    const r = await rodar();
    expect(r.falhas?.[0]).toMatch(/^30500: /);
    expect(eventos[0]).toMatchObject({ resultado: "falhou" });
    expect(notas()).toEqual([]);
  });

  it("reserva de uma rodada que caiu no meio: vira incerto, sem reenviar", async () => {
    eventos.push({
      id: "ev-0",
      provider: "FOLLOWUP_RESERVA",
      externalId: "reserva:30500",
      resultado: "reservado",
      createdAt: new Date(NA_HORA.getTime() - 20 * 60_000),
    });
    const r = await rodar();
    expect(r.incertos).toEqual([30500]);
    expect(eventos[0].resultado).toBe("incerto");
    expect(enviadas).toEqual([]);
  });
});

describe("follow-up de reserva — sombra e desligado", () => {
  it("sombra: lê de verdade e registra o ensaio, sem mensagem nem nota", async () => {
    integracao = { enabled: true, config: { modo: "sombra" } };
    const r = await rodar();
    expect(r.ensaios).toEqual([30500]);
    expect(enviadas).toEqual([]);
    expect(eventos[0]).toMatchObject({
      externalId: "sombra:reserva:30500",
      resultado: "ensaio",
      detalhe: expect.stringMatching(/^sombra: mandaria ao cliente/),
    });
  });

  it("o ensaio da sombra não impede o envio de verdade depois de ligar", async () => {
    integracao = { enabled: true, config: { modo: "sombra" } };
    await rodar();
    integracao = { enabled: true, config: { modo: "ligado" } };
    const r = await rodar(new Date(NA_HORA.getTime() + 5 * 60_000));
    expect(r.enviados).toEqual([30500]);
  });

  it("desligado: não lê nada", async () => {
    integracao = { enabled: false, config: {} };
    expect(await rodar()).toEqual({ acao: "desligada" });
    expect(leiturasNoConexa).toBe(0);
  });
});
