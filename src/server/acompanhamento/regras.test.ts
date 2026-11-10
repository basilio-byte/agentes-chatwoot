import { describe, expect, it } from "vitest";

import {
  aindaNoCiclo,
  chaveDaEtapa,
  comentarioDaEtapa,
  etapaAEnviar,
  ESPERA_APOS_FALA_MS,
  MARCADOR,
  mensagemDaEtapa,
  notaParaOVendedor,
  podeFalar,
  primeiroNome,
  STATUS_ALVO,
  type Etapa,
  type LinksDaContratacao,
} from "./regras";

const LINKS: LinksDaContratacao = {
  pagamento: "https://seahubcoworking.conexa.app/cobranca/1",
  assinatura: "https://app.zapsign.com.br/verificar/abc",
  documentoZapSign: "abc",
  contratoConexa: 10601,
};

const nada = new Set<Etapa>();

describe("etapaAEnviar", () => {
  it("com os dois links e nada enviado, manda a inicial", () => {
    expect(etapaAEnviar(LINKS, { pago: false, assinado: false }, nada)).toBe("inicial");
  });

  it("⚠ com UM link só, não manda nada: o outro falhou e há gente para resolver", () => {
    expect(
      etapaAEnviar({ ...LINKS, assinatura: null }, { pago: false, assinado: false }, nada),
    ).toBeNull();
    expect(
      etapaAEnviar({ ...LINKS, pagamento: null }, { pago: false, assinado: false }, nada),
    ).toBeNull();
  });

  it("pago e faltando assinar, depois da inicial, manda a de pagamento", () => {
    const enviadas = new Set<Etapa>(["inicial"]);
    expect(etapaAEnviar(LINKS, { pago: true, assinado: false }, enviadas)).toBe("pagamento");
  });

  it("assinado e faltando pagar, depois da inicial, manda a de assinatura", () => {
    const enviadas = new Set<Etapa>(["inicial"]);
    expect(etapaAEnviar(LINKS, { pago: false, assinado: true }, enviadas)).toBe("assinatura");
  });

  it("as duas confirmadas vão direto para a final, mesmo sem as do meio", () => {
    expect(etapaAEnviar(LINKS, { pago: true, assinado: true }, nada)).toBe("final");
    expect(
      etapaAEnviar(LINKS, { pago: true, assinado: true }, new Set<Etapa>(["inicial"])),
    ).toBe("final");
  });

  it("nada é repetido", () => {
    // Cada caso traz o estado que PEDIRIA aquela etapa, com ela já enviada.
    const casos: Array<[Etapa[], { pago: boolean; assinado: boolean }]> = [
      [["inicial"], { pago: false, assinado: false }],
      [["inicial", "pagamento"], { pago: true, assinado: false }],
      [["inicial", "assinatura"], { pago: false, assinado: true }],
      [["inicial", "pagamento", "final"], { pago: true, assinado: true }],
    ];
    for (const [enviadas, conf] of casos) {
      expect(etapaAEnviar(LINKS, conf, new Set(enviadas))).toBeNull();
    }
  });

  it("a inicial vem ANTES das de confirmação, como o fluxo do Diego", () => {
    expect(etapaAEnviar(LINKS, { pago: true, assinado: false }, nada)).toBe("inicial");
  });

  it("⚠ sem o link que a mensagem cita, a de confirmação não sai", () => {
    const enviadas = new Set<Etapa>(["inicial"]);
    expect(
      etapaAEnviar({ ...LINKS, assinatura: null }, { pago: true, assinado: false }, enviadas),
    ).toBeNull();
  });

  it("nada confirmado e inicial já enviada: espera", () => {
    expect(etapaAEnviar(LINKS, { pago: false, assinado: false }, new Set<Etapa>(["inicial"]))).toBeNull();
  });
});

describe("podeFalar — as travas da exceção", () => {
  const agora = new Date("2026-11-10T15:00:00Z");
  const haMinutos = (m: number) => new Date(agora.getTime() - m * 60_000);

  it("conversa sem mensagem nenhuma: pode", () => {
    expect(podeFalar({ status: "open", ultimaMensagem: null }, agora).pode).toBe(true);
  });

  it("⚠ conversa resolvida: não fala", () => {
    const r = podeFalar({ status: "resolved", ultimaMensagem: null }, agora);
    expect(r.pode).toBe(false);
    if (r.pode) throw new Error("deveria recusar");
    expect(r.motivo).toContain("resolvida");
  });

  it("⚠⚠ a equipe falou há pouco: NÃO corta o vendedor no meio", () => {
    const r = podeFalar(
      { status: "open", ultimaMensagem: { deQuem: "equipe", em: haMinutos(2) } },
      agora,
    );
    expect(r.pode).toBe(false);
    if (r.pode) throw new Error("deveria recusar");
    expect(r.motivo).toContain("a equipe escreveu");
  });

  it("⚠⚠ o cliente perguntou e ninguém respondeu: NÃO entra na frente", () => {
    const r = podeFalar(
      { status: "open", ultimaMensagem: { deQuem: "cliente", em: haMinutos(3) } },
      agora,
    );
    expect(r.pode).toBe(false);
    if (r.pode) throw new Error("deveria recusar");
    expect(r.motivo).toContain("ainda não foi respondido");
  });

  it("remetente de tipo desconhecido conta como equipe — a dúvida pende para o silêncio", () => {
    expect(
      podeFalar(
        { status: "open", ultimaMensagem: { deQuem: "desconhecido", em: haMinutos(1) } },
        agora,
      ).pode,
    ).toBe(false);
  });

  it("passada a espera, pode falar — a conversa está parada, não em andamento", () => {
    const limite = ESPERA_APOS_FALA_MS / 60_000;
    expect(
      podeFalar(
        { status: "open", ultimaMensagem: { deQuem: "cliente", em: haMinutos(limite) } },
        agora,
      ).pode,
    ).toBe(true);
    expect(
      podeFalar(
        { status: "open", ultimaMensagem: { deQuem: "equipe", em: haMinutos(limite + 60) } },
        agora,
      ).pode,
    ).toBe(true);
  });

  it("a última foi do próprio robô: não há ninguém para atropelar", () => {
    expect(
      podeFalar(
        { status: "open", ultimaMensagem: { deQuem: "robo", em: haMinutos(1) } },
        agora,
      ).pode,
    ).toBe(true);
  });

  it("conversa `pending` não é resolvida e não bloqueia", () => {
    expect(podeFalar({ status: "pending", ultimaMensagem: null }, agora).pode).toBe(true);
  });
});

describe("aindaNoCiclo", () => {
  it("sai quando o status deixa de ser onboarding", () => {
    expect(aindaNoCiclo({ status: "ongoing", etiquetas: ["pagamento pendente"] })).toBe(false);
    expect(aindaNoCiclo({ status: "Onboarding", etiquetas: ["pagamento pendente"] })).toBe(true);
  });

  it("⚠⚠ o status REAL da lista tem emoji, e precisa casar", () => {
    expect(
      aindaNoCiclo({ status: "🏃‍♂️onboarding", etiquetas: ["falta assinatura"] }),
    ).toBe(true);
    expect(STATUS_ALVO).toBe("🏃‍♂️onboarding");
  });

  it("sai quando as duas etiquetas saem — processo concluído", () => {
    expect(aindaNoCiclo({ status: "onboarding", etiquetas: [] })).toBe(false);
    expect(aindaNoCiclo({ status: "onboarding", etiquetas: ["ganho"] })).toBe(false);
    expect(aindaNoCiclo({ status: "onboarding", etiquetas: ["falta assinatura"] })).toBe(true);
  });
});

describe("mensagens", () => {
  const dados = { nome: "Carla Adriana de Lima", linkPagamento: "P", linkAssinatura: "A" };

  it("a inicial traz os dois links e o primeiro nome", () => {
    const t = mensagemDaEtapa("inicial", dados);
    expect(t).toContain("Olá, Carla!");
    expect(t).toContain("💳 Link de pagamento: P");
    expect(t).toContain("✍️ Link de assinatura: A");
  });

  it("a de pagamento cita só o link que falta", () => {
    const t = mensagemDaEtapa("pagamento", dados);
    expect(t).toContain("Identificamos o seu pagamento");
    expect(t).toContain("✍️ A");
    expect(t).not.toContain("💳");
  });

  it("a de assinatura cita só o link que falta", () => {
    const t = mensagemDaEtapa("assinatura", dados);
    expect(t).toContain("Identificamos a assinatura");
    expect(t).toContain("💳 P");
    expect(t).not.toContain("✍️");
  });

  it("a final não manda link nenhum", () => {
    const t = mensagemDaEtapa("final", dados);
    expect(t).toContain("Carla, confirmamos tudo!");
    expect(t).not.toContain("http");
    expect(t).not.toContain("drive.google.com");
  });

  it("⚠ sem nome, a saudação não vira 'Olá, tudo bem! Tudo bem?'", () => {
    expect(mensagemDaEtapa("inicial", { ...dados, nome: "" })).toContain("Olá! Tudo bem? 😊");
    expect(mensagemDaEtapa("pagamento", { ...dados, nome: "  " })).toContain("Boa notícia! ✅");
    expect(mensagemDaEtapa("final", { ...dados, nome: "" })).toContain("Confirmamos tudo! 🎉");
  });

  it("primeiroNome devolve nulo quando não há nome", () => {
    expect(primeiroNome("Maria Eduarda de Medeiros")).toBe("Maria");
    expect(primeiroNome("  ")).toBeNull();
    expect(primeiroNome(null)).toBeNull();
  });

  it("⚠ a mensagem ao CLIENTE não leva carimbo de robô", () => {
    for (const e of ["inicial", "pagamento", "assinatura", "final"] as Etapa[]) {
      expect(mensagemDaEtapa(e, dados)).not.toContain(MARCADOR);
      expect(mensagemDaEtapa(e, dados)).not.toContain("🤖");
    }
  });
});

describe("rastro para a equipe", () => {
  it("a nota interna diz que foi o sistema e que a conversa continua com o vendedor", () => {
    const nota = notaParaOVendedor("inicial", "https://app.clickup.com/t/abc");
    expect(nota).toContain(MARCADOR);
    expect(nota).toContain("a conversa continua com você");
    expect(nota).toContain("https://app.clickup.com/t/abc");
  });

  it("o comentário da task segue a convenção do Diego, com data e hora de São Paulo", () => {
    // 10/11/2026 15:00 UTC = 12:00 em São Paulo.
    const c = comentarioDaEtapa("final", new Date("2026-11-10T15:00:00Z"));
    expect(c).toBe("🤖 [Acomp. Contrato] Processo concluído — pagamento e assinatura confirmados em 10/11/2026 12:00");
  });

  it("a reserva é por task e etapa", () => {
    expect(chaveDaEtapa("86adm4t1k", "pagamento")).toBe("pagamento:86adm4t1k");
  });
});
