import { beforeEach, describe, expect, it, vi } from "vitest";
import { PresenteStatus } from "@/generated/prisma/enums";

/**
 * A rodada do presente de aniversário, com banco, Conexa, Chatwoot e WhatsApp
 * simulados: quando reserva, quando passa para a equipe, e quando NADA acontece.
 */

const AGORA = new Date("2026-09-22T15:00:00Z");

type Pedido = {
  id: string;
  chatwootConversationId: number;
  agentId: string;
  portaAgentId: string;
  clienteId: number;
  pessoaId: number | null;
  salaId: number;
  salaNome: string | null;
  data: string;
  inicio: string;
  fim: string;
  aniversario: string;
  status: PresenteStatus;
  venceEm: Date;
  vendaId: number | null;
  reservaId: number | null;
  resultado: string | null;
  criadoEm: Date;
  atualizadoEm: Date;
  finalizadoEm: Date | null;
};

let pedidos: Pedido[] = [];
let chamadas: string[] = [];
let ligada = true;
let vendas: Array<Record<string, unknown>> = [];
let reservasDoCliente: Array<Record<string, unknown>> = [];
let resultadoDaReserva: Record<string, unknown> | Error = {};
let conversa = { status: "open", assigneeId: null as number | null, assigneeTipo: null as string | null };

function novoPedido(extra: Partial<Pedido> = {}): Pedido {
  return {
    id: `p${pedidos.length + 1}`,
    chatwootConversationId: 99,
    agentId: "salas",
    portaAgentId: "porta",
    clienteId: 5872,
    pessoaId: null,
    salaId: 2107,
    salaNome: "Sala 03",
    data: "2026-09-25",
    inicio: "14:00",
    fim: "16:00",
    aniversario: "20/09",
    status: PresenteStatus.AGUARDANDO,
    venceEm: new Date("2026-09-22T16:00:00Z"),
    vendaId: null,
    reservaId: null,
    resultado: "Diego: avisado",
    criadoEm: new Date("2026-09-22T12:00:00Z"),
    atualizadoEm: new Date("2026-09-22T12:00:00Z"),
    finalizadoEm: null,
    ...extra,
  };
}

vi.mock("@/lib/db", () => ({
  db: {
    presenteDeAniversario: {
      findMany: async () =>
        pedidos.filter((p) => p.status === PresenteStatus.AGUARDANDO || p.status === PresenteStatus.PROCESSANDO),
      updateMany: async ({ where, data }: { where: { id?: string; status: PresenteStatus }; data: Partial<Pedido> }) => {
        const alvo = pedidos.filter((p) => (!where.id || p.id === where.id) && p.status === where.status);
        alvo.forEach((p) => Object.assign(p, data));
        return { count: alvo.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Pedido> }) => {
        const p = pedidos.find((x) => x.id === where.id)!;
        Object.assign(p, data);
        return p;
      },
    },
    integration: {
      findUnique: async () => ({ enabled: ligada, config: { avisar: [{ nome: "Diego", telefone: "+5584999999999" }] } }),
      update: async () => ({}),
    },
  },
}));

vi.mock("@/server/integrations/conexa/sistema", () => ({
  abrirConexa: async () => ({
    config: { baseUrl: "https://conexa.test", unidades: [], salas: [] },
    cliente: {
      listarVendas: async (f: { customerId: number; createdAtFrom: string }) => {
        chamadas.push(`conexa:vendas:${f.customerId}:${f.createdAtFrom}`);
        return { itens: vendas, temMais: false };
      },
      listarReservas: async () => ({ itens: reservasDoCliente, temMais: false }),
    },
    executar: async (ferramenta: string, entrada: Record<string, unknown>) => {
      chamadas.push(`conexa:${ferramenta}:${entrada.sala}:${entrada.data}:${entrada.inicio}-${entrada.fim}:pessoa-${entrada.solicitanteId ?? "nenhuma"}`);
      if (resultadoDaReserva instanceof Error) throw resultadoDaReserva;
      return resultadoDaReserva;
    },
  }),
}));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteDoAgente: async () => ({
    baseUrl: "https://chatwoot.test",
    contaId: 1,
    obterConversa: async () => conversa,
    enviarMensagem: async (id: number, texto: string, opcoes?: { privado?: boolean }) => {
      chamadas.push(`chatwoot:${opcoes?.privado ? "nota" : "mensagem"}:${id}:${texto}`);
      return { id: 1 };
    },
    alternarStatus: async (id: number, status: string) => chamadas.push(`chatwoot:status:${id}:${status}`),
    listarAtendentes: async () => [{ id: 7, name: "Diego Lima" }],
    atribuir: async (id: number, d: { assigneeId: number }) => chamadas.push(`chatwoot:atribuir:${id}:${d.assigneeId}`),
  }),
  clienteComTokenDeUsuario: async () => ({}),
}));

vi.mock("@/server/alerta-de-saldo/conversa", () => ({
  entregarAviso: async (_c: unknown, _caixa: number, destinatarios: Array<{ nome: string }>, texto: string) => {
    chamadas.push(`whatsapp:${texto.slice(0, 40)}`);
    return destinatarios.map((d) => ({ nome: d.nome, ok: true, detalhe: "ok", conversaId: 700 }));
  },
}));

vi.mock("@/server/integrations/chatwoot/resolucao", () => ({
  entregarAoHumano: async (id: number, motivo: string) => chamadas.push(`banco:humano:${id}:${motivo.slice(0, 30)}`),
}));

const { conferirPresentes, esquecerRodada } = await import("./conferir");

const tem = (comeco: string) => chamadas.some((c) => c.startsWith(comeco));
const posicao = (comeco: string) => chamadas.findIndex((c) => c.startsWith(comeco));

const vendaPaga = {
  saleId: 93568,
  product: { id: 1 },
  amount: 0,
  status: "paid",
  requesterId: 6505,
  createdAt: "2026-09-22T10:00:00-03:00",
};

const reservaDoPacote = {
  criada: true,
  reserva: { id: 28999, sala: "Sala de Reunião 03", status: "deductedFromQuota" },
};

beforeEach(() => {
  esquecerRodada();
  pedidos = [];
  chamadas = [];
  ligada = true;
  vendas = [];
  reservasDoCliente = [];
  resultadoDaReserva = reservaDoPacote;
  conversa = { status: "open", assigneeId: null, assigneeTipo: null };
});

describe("a rodada do presente de aniversário", () => {
  it("sem pedido esperando, nem abre o Conexa", async () => {
    expect(await conferirPresentes(AGORA)).toEqual({ acao: "nada" });
    expect(chamadas).toHaveLength(0);
  });

  it("confere no máximo a cada 5 minutos", async () => {
    pedidos.push(novoPedido());
    await conferirPresentes(AGORA);
    expect((await conferirPresentes(new Date(AGORA.getTime() + 60_000))).acao).toBe("cedo");
  });

  it("venda paga: reserva pela ferramenta dos agentes, confirma ao cliente e avisa a equipe", async () => {
    pedidos.push(novoPedido());
    vendas = [vendaPaga];

    const rodada = await conferirPresentes(AGORA);

    expect(rodada).toMatchObject({ acao: "conferido", reservados: 1 });
    // A pessoa da venda vai na reserva: é quem o Diego pôs como solicitante.
    expect(chamadas).toContain("conexa:conexa_criar_reserva:2107:2026-09-25:14:00-16:00:pessoa-6505");
    expect(tem("chatwoot:mensagem:99:🎉 Seu presente de aniversário está liberado!")).toBe(true);
    expect(chamadas.some((c) => c.startsWith("chatwoot:nota:99:✅ Presente de aniversário reservado"))).toBe(true);
    expect(chamadas.some((c) => c.startsWith("whatsapp:✅ Presente de aniversário reservado"))).toBe(true);
    expect(pedidos[0]).toMatchObject({ status: PresenteStatus.RESERVADO, reservaId: 28999, vendaId: 93568 });
  });

  it("a confirmação usa o nome da sala que o Conexa gravou", async () => {
    pedidos.push(novoPedido({ salaNome: null }));
    vendas = [vendaPaga];
    await conferirPresentes(AGORA);
    expect(chamadas.find((c) => c.startsWith("chatwoot:mensagem:99:"))).toContain("Sala de Reunião 03, no dia 25/09");
    expect(chamadas.find((c) => c.startsWith("chatwoot:nota:99:"))).toContain("Sala de Reunião 03");
  });

  it("⚠ reserva que NÃO saiu do pacote não é confirmada como presente: vai para a equipe", async () => {
    pedidos.push(novoPedido());
    vendas = [vendaPaga];
    resultadoDaReserva = { criada: true, reserva: { id: 29000, status: "notBilled" } };

    const rodada = await conferirPresentes(AGORA);

    expect(rodada.entregues).toBe(1);
    expect(chamadas.some((c) => c.includes("presente de aniversário está liberado"))).toBe(false);
    expect(tem("chatwoot:mensagem:99:Vou pedir para a nossa equipe finalizar a liberação")).toBe(true);
    expect(chamadas).toContain("chatwoot:atribuir:99:7");
    expect(chamadas.some((c) => c.startsWith("banco:humano:99"))).toBe(true);
    expect(pedidos[0]).toMatchObject({ status: PresenteStatus.ENTREGUE, reservaId: 29000 });
    expect(pedidos[0].resultado).toContain("NÃO saiu do pacote");
  });

  it("reserva recusada (horário tomado): vai para a equipe, sem confirmar nada", async () => {
    pedidos.push(novoPedido());
    vendas = [vendaPaga];
    resultadoDaReserva = { criada: false, erro: "O horário pedido não está livre nesta sala em 2026-09-25." };

    await conferirPresentes(AGORA);

    expect(pedidos[0].status).toBe(PresenteStatus.ENTREGUE);
    expect(pedidos[0].resultado).toContain("não está livre");
    expect(chamadas).toContain("chatwoot:atribuir:99:7");
  });

  it("Conexa sem confirmar a gravação: manda conferir a agenda antes de reservar", async () => {
    pedidos.push(novoPedido());
    vendas = [vendaPaga];
    resultadoDaReserva = { resultado: "indeterminado", erro: "timeout" };
    await conferirPresentes(AGORA);
    expect(pedidos[0].resultado).toContain("PODE ter entrado");
  });

  it("a equipe já reservou o horário: não reserva de novo nem manda confirmação", async () => {
    pedidos.push(novoPedido());
    vendas = [vendaPaga];
    reservasDoCliente = [
      { bookingId: 28380, customerId: 5872, startTime: "2026-09-25T14:00:00-03:00", finalTime: "2026-09-25T16:00:00-03:00", status: "deductedFromQuota" },
    ];

    await conferirPresentes(AGORA);

    expect(chamadas.some((c) => c.includes("conexa_criar_reserva"))).toBe(false);
    expect(chamadas.some((c) => c.startsWith("chatwoot:mensagem"))).toBe(false);
    expect(pedidos[0]).toMatchObject({ status: PresenteStatus.RESERVADO, reservaId: 28380 });
  });

  it("⚠ reserva do cliente no horário que NÃO saiu do pacote: vai para a equipe, sem reservar de novo", async () => {
    pedidos.push(novoPedido());
    vendas = [vendaPaga];
    reservasDoCliente = [
      { bookingId: 28381, customerId: 5872, startTime: "2026-09-25T14:00:00-03:00", finalTime: "2026-09-25T16:00:00-03:00", status: "notBilled" },
    ];

    await conferirPresentes(AGORA);

    expect(chamadas.some((c) => c.includes("conexa_criar_reserva"))).toBe(false);
    expect(tem("chatwoot:mensagem:99:🎉")).toBe(false);
    expect(pedidos[0]).toMatchObject({ status: PresenteStatus.ENTREGUE, reservaId: 28381 });
    expect(pedidos[0].resultado).toContain("NÃO saiu do pacote");
  });

  it("com uma pessoa dona da conversa, reserva mas não fala por cima dela", async () => {
    pedidos.push(novoPedido());
    vendas = [vendaPaga];
    conversa = { status: "open", assigneeId: 7, assigneeTipo: "User" };

    await conferirPresentes(AGORA);

    expect(chamadas.some((c) => c.startsWith("chatwoot:mensagem"))).toBe(false);
    expect(chamadas.find((c) => c.startsWith("chatwoot:nota"))).toBeDefined();
    expect(pedidos[0].status).toBe(PresenteStatus.RESERVADO);
    expect(pedidos[0].resultado).toContain("cliente NÃO avisado");
  });

  it("sem venda e dentro do prazo: espera, sem dizer nada a ninguém", async () => {
    pedidos.push(novoPedido({ venceEm: new Date("2026-09-22T18:00:00Z") }));
    await conferirPresentes(AGORA);
    expect(pedidos[0].status).toBe(PresenteStatus.AGUARDANDO);
    expect(chamadas.filter((c) => !c.startsWith("conexa:vendas"))).toHaveLength(0);
  });

  it("venda lançada mas não paga: espera", async () => {
    pedidos.push(novoPedido({ venceEm: new Date("2026-09-22T18:00:00Z") }));
    vendas = [{ ...vendaPaga, status: "billed" }];
    await conferirPresentes(AGORA);
    expect(pedidos[0].status).toBe(PresenteStatus.AGUARDANDO);
  });

  it("prazo vencido sem o pacote: a conversa vai para o Diego, com aviso ao cliente", async () => {
    pedidos.push(novoPedido({ venceEm: new Date("2026-09-22T14:00:00Z") }));

    const rodada = await conferirPresentes(AGORA);

    expect(rodada.entregues).toBe(1);
    // O aviso sai ANTES de atribuir: com dono, o robô cala.
    const aviso = posicao("chatwoot:mensagem:99:Vou pedir para a nossa equipe finalizar a liberação");
    const atribuir = chamadas.indexOf("chatwoot:atribuir:99:7");
    expect(aviso).toBeGreaterThan(-1);
    expect(atribuir).toBeGreaterThan(aviso);
    expect(chamadas.some((c) => c.startsWith("whatsapp:⏱️ Presente de aniversário"))).toBe(true);
    expect(pedidos[0].status).toBe(PresenteStatus.ENTREGUE);
    expect(pedidos[0].resultado).toContain("não foi lançado");
  });

  it("prazo vencido com a conversa já com uma pessoa: só a nota", async () => {
    pedidos.push(novoPedido({ venceEm: new Date("2026-09-22T14:00:00Z") }));
    conversa = { status: "open", assigneeId: 7, assigneeTipo: "User" };
    await conferirPresentes(AGORA);
    expect(chamadas.some((c) => c.startsWith("chatwoot:mensagem"))).toBe(false);
    expect(chamadas.some((c) => c.startsWith("chatwoot:atribuir"))).toBe(false);
    expect(pedidos[0].status).toBe(PresenteStatus.ENTREGUE);
  });

  it("integração desligada: o que esperava é cancelado, sem agir", async () => {
    ligada = false;
    pedidos.push(novoPedido());
    vendas = [vendaPaga];
    expect((await conferirPresentes(AGORA)).acao).toBe("desligada");
    expect(pedidos[0].status).toBe(PresenteStatus.CANCELADO);
    expect(chamadas).toHaveLength(0);
  });

  it("PROCESSANDO que ficou para trás vira FALHOU, sem reservar de novo", async () => {
    pedidos.push(
      novoPedido({ status: PresenteStatus.PROCESSANDO, atualizadoEm: new Date(AGORA.getTime() - 20 * 60_000) }),
    );
    vendas = [vendaPaga];
    await conferirPresentes(AGORA);
    expect(chamadas.some((c) => c.includes("conexa_criar_reserva"))).toBe(false);
    expect(pedidos[0].status).toBe(PresenteStatus.FALHOU);
    expect(chamadas.some((c) => c.startsWith("whatsapp:⚠️"))).toBe(true);
  });

  it("PROCESSANDO recente é de uma rodada viva: não mexe", async () => {
    pedidos.push(novoPedido({ status: PresenteStatus.PROCESSANDO, atualizadoEm: new Date(AGORA.getTime() - 60_000) }));
    await conferirPresentes(AGORA);
    expect(pedidos[0].status).toBe(PresenteStatus.PROCESSANDO);
  });

  it("a venda é procurada a partir de um pouco antes do pedido", async () => {
    pedidos.push(novoPedido({ venceEm: new Date("2026-09-22T18:00:00Z") }));
    await conferirPresentes(AGORA);
    // Pedido às 9h: procura desde 8h30, no relógio de São Paulo.
    expect(chamadas).toContain("conexa:vendas:5872:2026-09-22T08:30:00-03:00");
  });
});
