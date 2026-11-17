import { describe, expect, it } from "vitest";
import type { MensagemChatwoot } from "@/server/integrations/chatwoot/client";
import { followupConfigSchema, TEXTO_PADRAO } from "./config";
import {
  chaveDaReserva,
  decidirEnvio,
  diaDaReserva,
  horaCurta,
  momentoDoFollowup,
  nomeDaSala,
  primeiroNome,
  textoDoFollowup,
  ultimaMensagemDoCliente,
  valorEmReais,
} from "./regras";

const config = followupConfigSchema.parse({});
/** Instante em São Paulo (UTC−3, sem horário de verão). */
const sp = (texto: string) => new Date(`${texto}:00-03:00`);
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("momentoDoFollowup", () => {
  it("conversa 11708: reservou às 10h02 para as 17h do mesmo dia → follow-up às 14h", () => {
    const m = momentoDoFollowup({
      inicio: sp("2026-11-16T17:00"),
      criadaEm: sp("2026-11-16T10:02"),
      ultimaDoCliente: sp("2026-11-16T10:02"),
      config,
    });
    expect(iso(m)).toBe(iso(sp("2026-11-16T14:00")));
  });

  it("reserva às 8h do dia seguinte: o follow-up sai na véspera, antes das 20h, e não de madrugada", () => {
    const m = momentoDoFollowup({
      inicio: sp("2026-11-17T08:00"),
      criadaEm: sp("2026-11-16T15:00"),
      ultimaDoCliente: sp("2026-11-16T15:00"),
      config,
    });
    expect(iso(m)).toBe(iso(sp("2026-11-16T19:59")));
  });

  it("reserva com semanas de antecedência: sai antes de a janela de 24 h do WhatsApp fechar", () => {
    // Reservou 04/11 às 20h08 para 24/11: a janela conta da última mensagem do
    // cliente, e 22 h depois ainda é horário de envio.
    const m = momentoDoFollowup({
      inicio: sp("2026-11-24T08:00"),
      criadaEm: sp("2026-11-04T20:08"),
      ultimaDoCliente: sp("2026-11-04T20:08"),
      config,
    });
    expect(iso(m)).toBe(iso(sp("2026-11-05T18:08")));
  });

  it("o cliente escreveu depois de reservar: a janela anda, e o follow-up chega mais perto do horário", () => {
    const m = momentoDoFollowup({
      inicio: sp("2026-11-24T15:00"),
      criadaEm: sp("2026-11-04T20:08"),
      ultimaDoCliente: sp("2026-11-23T16:00"),
      config,
    });
    expect(iso(m)).toBe(iso(sp("2026-11-24T12:00")));
  });

  it("janela que fecha de madrugada: sai no último horário de envio antes dela", () => {
    const m = momentoDoFollowup({
      inicio: sp("2026-11-20T15:00"),
      criadaEm: sp("2026-11-16T07:30"),
      ultimaDoCliente: sp("2026-11-16T07:30"),
      config,
    });
    // 07h30 + 22 h = 05h30 do dia 17 → último horário permitido antes: 19h59 do dia 16.
    expect(iso(m)).toBe(iso(sp("2026-11-16T19:59")));
  });

  it("nunca antes de 30 min depois de reservar", () => {
    const m = momentoDoFollowup({
      inicio: sp("2026-11-16T14:00"),
      criadaEm: sp("2026-11-16T13:00"),
      ultimaDoCliente: sp("2026-11-16T13:00"),
      config,
    });
    expect(iso(m)).toBe(iso(sp("2026-11-16T13:30")));
  });

  it("reservou à noite para as 8h: não há horário possível", () => {
    expect(
      momentoDoFollowup({
        inicio: sp("2026-11-17T08:00"),
        criadaEm: sp("2026-11-16T21:00"),
        ultimaDoCliente: sp("2026-11-16T21:00"),
        config,
      }),
    ).toBeNull();
  });

  it("começa logo depois de reservar: não há horário possível", () => {
    expect(
      momentoDoFollowup({
        inicio: sp("2026-11-16T13:40"),
        criadaEm: sp("2026-11-16T13:00"),
        ultimaDoCliente: sp("2026-11-16T13:00"),
        config,
      }),
    ).toBeNull();
  });
});

const msg = (id: number, tipo: number, quando: Date, extra: Partial<MensagemChatwoot> = {}): MensagemChatwoot => ({
  id,
  content: "x",
  message_type: tipo,
  created_at: Math.floor(quando.getTime() / 1000),
  ...extra,
});

describe("ultimaMensagemDoCliente", () => {
  it("a mais recente de entrada; sem nenhuma, null", () => {
    const m = [msg(1, 0, sp("2026-11-16T10:00")), msg(2, 1, sp("2026-11-16T10:01")), msg(3, 0, sp("2026-11-16T10:02"))];
    expect(iso(ultimaMensagemDoCliente(m))).toBe(iso(sp("2026-11-16T10:02")));
    expect(ultimaMensagemDoCliente([msg(2, 1, sp("2026-11-16T10:01"))])).toBeNull();
  });
});

describe("decidirEnvio", () => {
  const livre = { status: "resolved", assigneeId: null, assigneeTipo: null };
  const base = {
    agora: sp("2026-11-16T14:00"),
    inicio: sp("2026-11-16T17:00"),
    ultimaDoCliente: sp("2026-11-16T10:02"),
    conversa: livre,
    mensagens: [msg(10, 0, sp("2026-11-16T10:02")), msg(11, 1, sp("2026-11-16T10:03"))],
    config,
  };

  it("conversa resolvida, sem ninguém: envia", () => {
    expect(decidirEnvio(base)).toEqual({ acao: "enviar" });
  });

  it("aberta com o nosso robô como dono, parada há horas: envia", () => {
    expect(
      decidirEnvio({ ...base, conversa: { status: "open", assigneeId: 4, assigneeTipo: "AgentBot" } }),
    ).toEqual({ acao: "enviar" });
  });

  it("aberta com uma pessoa da equipe: nada ao cliente, nota para quem atende", () => {
    expect(
      decidirEnvio({
        ...base,
        conversa: { status: "open", assigneeId: 21, assigneeTipo: "User", assigneeNome: "Wellen Kelly" },
      }),
    ).toEqual({ acao: "avisar-quem-atende", quem: "Wellen Kelly" });
  });

  it("dono de tipo desconhecido conta como pessoa", () => {
    expect(
      decidirEnvio({ ...base, conversa: { status: "open", assigneeId: 21, assigneeTipo: null } }).acao,
    ).toBe("avisar-quem-atende");
  });

  it("resolvida com dono que sobrou: ninguém está falando com o cliente, envia", () => {
    expect(
      decidirEnvio({ ...base, conversa: { status: "resolved", assigneeId: 21, assigneeTipo: "User" } }),
    ).toEqual({ acao: "enviar" });
  });

  it("o cliente está esperando resposta: aguarda", () => {
    const d = decidirEnvio({
      ...base,
      conversa: { status: "open", assigneeId: null, assigneeTipo: null },
      mensagens: [...base.mensagens, msg(12, 0, sp("2026-11-16T13:00"))],
    });
    expect(d).toMatchObject({ acao: "aguardar", motivo: "o cliente está esperando resposta" });
  });

  it("alguém escreveu há menos de 10 min: aguarda; nota interna não conta", () => {
    const aberta = { status: "open", assigneeId: null, assigneeTipo: null };
    expect(
      decidirEnvio({ ...base, conversa: aberta, mensagens: [...base.mensagens, msg(12, 1, sp("2026-11-16T13:55"))] }),
    ).toMatchObject({ acao: "aguardar", motivo: "a conversa está em andamento" });
    expect(
      decidirEnvio({
        ...base,
        conversa: aberta,
        mensagens: [...base.mensagens, msg(12, 1, sp("2026-11-16T13:55"), { private: true })],
      }),
    ).toEqual({ acao: "enviar" });
  });

  it("fora do horário de envio: aguarda", () => {
    expect(decidirEnvio({ ...base, agora: sp("2026-11-16T21:00"), inicio: sp("2026-11-17T17:00"), ultimaDoCliente: sp("2026-11-16T20:00") })).toMatchObject({
      acao: "aguardar",
      motivo: "fora do horário de envio",
    });
  });

  it("a reserva começa em menos de 30 min: desiste", () => {
    expect(decidirEnvio({ ...base, agora: sp("2026-11-16T16:40") }).acao).toBe("desistir");
  });

  it("23 h depois da última mensagem do cliente: desiste, a janela pode estar fechada", () => {
    expect(
      decidirEnvio({ ...base, agora: sp("2026-11-17T09:10"), inicio: sp("2026-11-17T17:00") }),
    ).toMatchObject({ acao: "desistir", motivo: expect.stringMatching(/janela de 24 h/) });
  });
});

describe("o texto ao cliente", () => {
  const dados = {
    nome: "Diego",
    sala: "Sala de Reunião 01 (Seaway)",
    data: "hoje, 16/11",
    inicio: "17h",
    fim: "18h",
    valor: "R$ 70,00",
    link: "https://seahubcoworking.conexa.app/index.php?r=cobranca/fatura&id=abc",
  };

  it("troca todos os marcadores do texto padrão", () => {
    const t = textoDoFollowup(TEXTO_PADRAO, dados);
    expect(t).toContain("Oi, Diego! Passando para confirmar a sua reserva:");
    expect(t).toContain("🛋️ Sala de Reunião 01 (Seaway)");
    expect(t).toContain("📅 hoje, 16/11, das 17h às 18h");
    expect(t).toContain("pagamento de R$ 70,00");
    expect(t).toContain(dados.link);
    expect(t).not.toMatch(/\{[a-z]+\}/);
  });

  it("sem nome, “Oi, {nome}!” vira “Oi!”", () => {
    expect(textoDoFollowup(TEXTO_PADRAO, { ...dados, nome: null })).toMatch(/^Oi! Passando/);
  });

  it("nome da sala como o cliente lê", () => {
    expect(nomeDaSala("[SEAWAY] - SALA DE REUNIÃO 01 - 10 pessoas")).toBe("Sala de Reunião 01 (Seaway)");
    expect(nomeDaSala("[AYRTON SENNA] - SALA DE ATENDIMENTO 02 - 3 pessoas")).toBe(
      "Sala de Atendimento 02 (Ayrton Senna)",
    );
    expect(nomeDaSala("Cabine")).toBe("Cabine");
    expect(nomeDaSala(null)).toBe("a sala reservada");
  });

  it("dia e hora no relógio de São Paulo", () => {
    const agora = sp("2026-11-16T14:00");
    expect(diaDaReserva(sp("2026-11-16T17:00"), agora)).toBe("hoje, 16/11");
    expect(diaDaReserva(sp("2026-11-17T08:00"), agora)).toBe("amanhã, 17/11");
    expect(diaDaReserva(sp("2026-11-24T08:00"), agora)).toBe("terça-feira, 24/11");
    expect(horaCurta(sp("2026-11-16T17:00"))).toBe("17h");
    expect(horaCurta(sp("2026-11-16T09:30"))).toBe("9h30");
  });

  it("valor e primeiro nome", () => {
    expect(valorEmReais(70)).toBe("R$ 70,00");
    expect(primeiroNome("diego mendonça")).toBe("Diego");
    expect(primeiroNome("+55 84 98765-4321")).toBeNull();
    expect(primeiroNome("")).toBeNull();
  });
});

describe("a chave do desfecho", () => {
  it("a sombra tem a sua: ensaiar não impede o envio de verdade", () => {
    expect(chaveDaReserva(30500, "ligado")).toBe("reserva:30500");
    expect(chaveDaReserva(30500, "sombra")).toBe("sombra:reserva:30500");
  });
});
