import { describe, expect, it } from "vitest";
import {
  donoNaoEhHumano,
  ehResolvida,
  humanidadeDoDono,
  podeAgir,
  precisaAbrir,
} from "./regras";

describe("regra 1 — não interferir em conversa de humano", () => {
  it("cala quando existe responsável humano, mesmo com a conversa aberta", () => {
    const r = podeAgir({ status: "open", assigneeId: 42 });

    expect(r.pode).toBe(false);
    if (!r.pode) expect(r.motivo).toContain("humano");
  });

  it("cala mesmo em conversa pendente atribuída", () => {
    expect(podeAgir({ status: "pending", assigneeId: 7 }).pode).toBe(false);
  });

  it("age quando o responsável foi removido", () => {
    expect(podeAgir({ status: "open", assigneeId: null }).pode).toBe(true);
    expect(podeAgir({ status: "pending" }).pode).toBe(true);
  });
});

/**
 * O caso de 17/08/2026: o Chatwoot atribui o PRÓPRIO Agent Bot à conversa em
 * algumas caixas. A regra lia isso como "um humano assumiu" e o bot calava para
 * sempre — a conversa resolvida nem reabria, porque reabrir exige não ter dono.
 * Silêncio permanente, sem erro nenhum, e invisível: o bot também não aparece
 * no filtro de "Agente atribuído" do Chatwoot.
 */
describe("regra 1b — dono que não é gente não cala o bot", () => {
  it("segue atendendo quando o dono é o próprio bot", () => {
    const r = podeAgir({ status: "open", assigneeId: 9, donoEhHumano: false });

    expect(r.pode).toBe(true);
    expect(r.donoNaoHumano).toBe(true);
  });

  it("na dúvida, cala — falar por cima de um atendente é pior", () => {
    // `donoEhHumano` ausente é o caso de a lista de agentes não ter carregado.
    // A incerteza sempre pende para o silêncio.
    expect(podeAgir({ status: "open", assigneeId: 9 }).pode).toBe(false);
    expect(
      podeAgir({ status: "open", assigneeId: 9, donoEhHumano: true }).pode,
    ).toBe(false);
  });

  it("resolvida continua resolvida, mas avisa que o dono é o bot", () => {
    // Quem reabre precisa dos dois sinais: que está resolvida e que o dono não
    // é gente — senão a reabertura continuaria travada pelo responsável.
    const r = podeAgir({
      status: "resolved",
      assigneeId: 9,
      donoEhHumano: false,
    });

    expect(r.pode).toBe(false);
    if (r.pode) return;
    expect(r.resolvida).toBe(true);
    expect(r.donoNaoHumano).toBe(true);
  });

  it("sem dono nenhum, não há dono não-humano", () => {
    expect(podeAgir({ status: "open" }).donoNaoHumano).toBe(false);
    // Nem quando alguém passa `donoEhHumano: false` sem dono — não há a quem
    // se referir, e concluir "é o bot" a partir do nada seria invenção.
    expect(
      podeAgir({ status: "open", assigneeId: null, donoEhHumano: false })
        .donoNaoHumano,
    ).toBe(false);
  });
});

describe("donoNaoEhHumano", () => {
  it("exige dono E prova de que não é gente", () => {
    expect(donoNaoEhHumano({ assigneeId: 9, donoEhHumano: false })).toBe(true);
    expect(donoNaoEhHumano({ assigneeId: 9, donoEhHumano: true })).toBe(false);
    expect(donoNaoEhHumano({ assigneeId: 9 })).toBe(false);
    expect(donoNaoEhHumano({ assigneeId: null, donoEhHumano: false })).toBe(false);
  });
});

describe("regra 2 — não interagir em conversa resolvida", () => {
  it("cala em conversa resolvida", () => {
    const r = podeAgir({ status: "resolved" });

    expect(r.pode).toBe(false);
    if (!r.pode) {
      expect(r.motivo).toContain("resolvida");
      expect(r.resolvida).toBe(true);
    }
  });

  it("sinaliza a resolução para quem precisa cortar o histórico", () => {
    const r = podeAgir({ status: "RESOLVED" }); // caixa não importa
    expect(r.pode).toBe(false);
    if (!r.pode) expect(r.resolvida).toBe(true);
  });

  it("cala em qualquer status fora do permitido", () => {
    expect(podeAgir({ status: "snoozed" }).pode).toBe(false);
  });

  it("age em aberta e pendente sem responsável", () => {
    expect(podeAgir({ status: "open" }).pode).toBe(true);
    expect(podeAgir({ status: "pending" }).pode).toBe(true);
  });

  it("sem status informado, não bloqueia por status", () => {
    expect(podeAgir({}).pode).toBe(true);
  });
});

describe("detecção de resolução", () => {
  it("reconhece independentemente da caixa", () => {
    expect(ehResolvida("resolved")).toBe(true);
    expect(ehResolvida("Resolved")).toBe(true);
    expect(ehResolvida("open")).toBe(false);
    expect(ehResolvida(null)).toBe(false);
    expect(ehResolvida(undefined)).toBe(false);
  });
});

describe("precedência", () => {
  it("humano vence resolvida na explicação — o motivo mais acionável", () => {
    const r = podeAgir({ status: "resolved", assigneeId: 9 });
    expect(r.pode).toBe(false);
    if (!r.pode) expect(r.motivo).toContain("humano");
  });
});

describe("o bot nunca deixa a conversa pendente", () => {
  it("pendente precisa ser aberta", () => {
    // `pending` não aparece na visualização padrão do Chatwoot: a conversa
    // ficaria invisível para a equipe enquanto o bot a atende.
    expect(precisaAbrir("pending")).toBe(true);
  });

  it("aberta não vira chamada à toa", () => {
    expect(precisaAbrir("open")).toBe(false);
  });

  it("resolvida não é reaberta pelo bot", () => {
    // Encerrar e reabrir atendimento é decisão de pessoa. Além disso o agente
    // nem chega aqui: `podeAgir` já o barrou.
    expect(precisaAbrir("resolved")).toBe(false);
  });

  it("status ausente ou desconhecido não dispara nada", () => {
    expect(precisaAbrir(null)).toBe(false);
    expect(precisaAbrir(undefined)).toBe(false);
    expect(precisaAbrir("snoozed")).toBe(false);
  });

  it("o bot age em pendente, mas não termina nele", () => {
    // As duas regras juntas: pode atender a conversa que chega pendente...
    expect(podeAgir({ status: "pending" }).pode).toBe(true);
    // ...e tem de deixá-la aberta ao terminar.
    expect(precisaAbrir("pending")).toBe(true);
  });
});

/**
 * O campo que separa uma pessoa do nosso Agent Bot.
 *
 * Descoberto em 17/08/2026 lendo a API em produção. A tentativa anterior —
 * comparar o id do responsável com a lista de `GET /agents` — **não funcionava**:
 * as tabelas de usuário e de AgentBot do Chatwoot têm sequências de id
 * independentes e colidem. Naquela conta, o bot "Seahub Coworking" e a agente
 * Maria Eduarda são ambos o id 4.
 */
describe("humanidadeDoDono", () => {
  it("User é gente", () => {
    expect(humanidadeDoDono("User")).toBe(true);
    expect(humanidadeDoDono("user")).toBe(true);
    expect(humanidadeDoDono(" User ")).toBe(true);
  });

  it("AgentBot não é gente", () => {
    expect(humanidadeDoDono("AgentBot")).toBe(false);
  });

  it("qualquer tipo desconhecido também não é gente", () => {
    // Só `User` é pessoa. Um tipo novo que apareça não deve virar "humano" por
    // omissão — senão o bot voltaria a calar sozinho.
    expect(humanidadeDoDono("Team")).toBe(false);
    expect(humanidadeDoDono("Whatever")).toBe(false);
  });

  it("ausente é `undefined`, e não `false`", () => {
    // Instância que não mande o campo volta ao comportamento conservador. Se
    // isto devolvesse `false`, o bot passaria a falar por cima de atendentes.
    expect(humanidadeDoDono(undefined)).toBeUndefined();
    expect(humanidadeDoDono(null)).toBeUndefined();
    expect(humanidadeDoDono("")).toBeUndefined();
    expect(humanidadeDoDono("   ")).toBeUndefined();
  });

  it("encaixa direto no veredito", () => {
    const comoBot = podeAgir({
      status: "pending",
      assigneeId: 4,
      donoEhHumano: humanidadeDoDono("AgentBot"),
    });
    expect(comoBot.pode).toBe(true);

    // Mesmo id, tipo diferente: agora é a Maria Eduarda, e o bot cala.
    const comoPessoa = podeAgir({
      status: "pending",
      assigneeId: 4,
      donoEhHumano: humanidadeDoDono("User"),
    });
    expect(comoPessoa.pode).toBe(false);
  });
});
