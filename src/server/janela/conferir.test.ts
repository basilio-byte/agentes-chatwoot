import { beforeEach, describe, expect, it, vi } from "vitest";
import { ETIQUETA_ABERTA, ETIQUETA_FECHADA, MARCA_DA_NOTA } from "./regras";

/**
 * O que a conferência não pode errar: marcar como fechada a janela que o
 * cliente acabou de reabrir, deixar a mesma nota duas vezes, contar como dada
 * uma nota que não saiu, apagar etiqueta alheia, e mexer em caixa sem janela.
 */

type Mensagem = {
  id: number;
  message_type: number;
  private?: boolean;
  created_at: number;
  content: string;
};
type Conversa = {
  id: number;
  inbox: number;
  status: "open" | "pending" | "resolved";
  etiquetas: string[];
  contato: number;
};

const H = 3600;
const AGORA = new Date("2026-09-22T15:00:00Z");
const S = Math.floor(AGORA.getTime() / 1000);

let linha: { enabled: boolean; config: unknown } | null;
let rodadasRegistradas: { status: string; lastError: string | null }[];
let eventos: Map<string, { id: string; resultado: string | null; detalhe?: string | null }>;
let conversas: Conversa[];
let mensagens: Map<number, Mensagem[]>;
let notas: { conversa: number; texto: string; privado: boolean }[];
let etiquetasGravadas: { conversa: number; etiquetas: string[] }[];
let leituras: number[];
let notaFalha: boolean;
/** Roda depois de cada leitura de mensagens: é onde o cliente "escreve" no meio da conferência. */
let depoisDeLer: ((conversa: number) => void) | null;
let proximoId: number;

vi.mock("@/lib/db", () => ({
  db: {
    integration: {
      findUnique: async () => linha,
      update: async ({ data }: { data: { status: string; lastError: string | null } }) => {
        rodadasRegistradas.push({ status: data.status, lastError: data.lastError });
      },
    },
    webhookEvent: {
      findUnique: async ({ where }: { where: { provider_externalId: { externalId: string } } }) =>
        eventos.get(where.provider_externalId.externalId) ?? null,
      create: async ({ data }: { data: { externalId: string; resultado: string; detalhe?: string } }) => {
        if (eventos.has(data.externalId)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const id = `ev-${eventos.size + 1}-${data.externalId}`;
        eventos.set(data.externalId, { id, resultado: data.resultado, detalhe: data.detalhe });
        return { id };
      },
      upsert: async ({ where, create }: { where: { provider_externalId: { externalId: string } }; create: { externalId: string; resultado: string } }) => {
        const chave = where.provider_externalId.externalId;
        if (!eventos.has(chave)) eventos.set(chave, { id: `ev-${eventos.size + 1}-${chave}`, resultado: create.resultado });
      },
      update: async ({ where, data }: { where: { id: string }; data: { resultado: string } }) => {
        for (const e of eventos.values()) if (e.id === where.id) e.resultado = data.resultado;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        for (const [chave, e] of eventos) if (e.id === where.id) eventos.delete(chave);
      },
    },
  },
}));

function ultimaNaoAtividade(id: number) {
  const lista = (mensagens.get(id) ?? []).filter((m) => m.message_type !== 2);
  const m = lista.at(-1);
  return m
    ? { id: m.id, criadaEm: m.created_at, privada: m.private === true, tipo: m.message_type }
    : null;
}

const leitor = {
  listarConversas: async (f: { inboxId: number; status: string; pagina: number }) => {
    const filtradas = conversas.filter((c) => c.inbox === f.inboxId && c.status === f.status);
    return {
      conversas: filtradas.slice((f.pagina - 1) * 25, f.pagina * 25).map((c) => ({
        id: c.id,
        inboxId: c.inbox,
        status: c.status,
        contatoId: c.contato,
        etiquetas: [...c.etiquetas],
        ultimaMensagem: ultimaNaoAtividade(c.id),
      })),
      total: filtradas.length,
    };
  },
  listarMensagensAntes: async (conversa: number, antesDe?: number) => {
    leituras.push(conversa);
    const todas = (mensagens.get(conversa) ?? []).filter((m) => antesDe == null || m.id < antesDe);
    const pagina = todas.slice(-20);
    depoisDeLer?.(conversa);
    return pagina;
  },
  listarMensagens: async (conversa: number) => (mensagens.get(conversa) ?? []).slice(-20),
  conversasDoContato: async (contato: number) =>
    conversas
      .filter((c) => c.contato === contato)
      .map((c) => ({
        id: c.id,
        caixaId: c.inbox,
        status: c.status,
        ultimaAtividadeEm: (mensagens.get(c.id) ?? []).at(-1)?.created_at ?? null,
      })),
  listarLabels: async (conversa: number) => [
    ...(conversas.find((c) => c.id === conversa)?.etiquetas ?? []),
  ],
  definirLabels: async () => {
    throw new Error("o leitor não escreve etiqueta: quem escreve é o robô da caixa");
  },
  enviarMensagem: async () => {
    throw new Error("o leitor não escreve nota: quem escreve é o robô da caixa");
  },
};

const robo = {
  enviarMensagem: async (conversa: number, texto: string, opcoes: { privado?: boolean }) => {
    if (notaFalha) throw new Error("Chatwoot respondeu 500");
    notas.push({ conversa, texto, privado: opcoes.privado === true });
    return { id: proximoId++ };
  },
  definirLabels: async (conversa: number, etiquetas: string[]) => {
    etiquetasGravadas.push({ conversa, etiquetas });
    const c = conversas.find((x) => x.id === conversa)!;
    c.etiquetas = etiquetas;
  },
  listarLabels: leitor.listarLabels,
};

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteDeLeitura: async () => ({ cliente: leitor, config: {} }),
  clienteDoAgente: async () => robo,
}));

vi.mock("@/server/integrations/chatwoot/porta", () => ({
  portaDaCaixa: async () => "agente-da-porta",
}));

const { conferirJanelas, esquecerConferenciaDeJanelas, TETO_DE_ESCRITAS_POR_RODADA } = await import(
  "./conferir"
);

function conversa(
  id: number,
  mensagensDaConversa: { tipo: number; haHoras: number; privada?: boolean }[],
  extra: Partial<Conversa> = {},
) {
  conversas.push({ id, inbox: 29, status: "open", etiquetas: [ETIQUETA_ABERTA], contato: id, ...extra });
  mensagens.set(
    id,
    mensagensDaConversa
      .map((m) => ({
        id: proximoId++,
        message_type: m.tipo,
        private: m.privada ?? false,
        created_at: S - Math.round(m.haHoras * H),
        content: "…",
      }))
      .sort((a, b) => a.created_at - b.created_at || a.id - b.id),
  );
}

const rodar = () => conferirJanelas(AGORA, { forcar: true });

beforeEach(() => {
  esquecerConferenciaDeJanelas();
  linha = { enabled: true, config: {} };
  rodadasRegistradas = [];
  eventos = new Map();
  conversas = [];
  mensagens = new Map();
  notas = [];
  etiquetasGravadas = [];
  leituras = [];
  notaFalha = false;
  depoisDeLer = null;
  proximoId = 1000;
});

describe("conferirJanelas", () => {
  it("desligada não lê nada", async () => {
    linha = { enabled: false, config: {} };
    conversa(1, [{ tipo: 0, haHoras: 30 }]);
    expect(await rodar()).toEqual({ acao: "desligada" });
    expect(leituras).toEqual([]);
  });

  it("janela vencida marcada como aberta: troca a etiqueta pelo robô, mantém as outras, sem nota", async () => {
    conversa(1, [{ tipo: 0, haHoras: 30 }, { tipo: 1, haHoras: 29 }], {
      etiquetas: ["crm_clickup", ETIQUETA_ABERTA],
    });

    const rodada = await rodar();

    expect(etiquetasGravadas).toEqual([
      { conversa: 1, etiquetas: ["crm_clickup", ETIQUETA_FECHADA] },
    ]);
    expect(notas).toEqual([]);
    expect(rodada).toMatchObject({ acao: "conferido", fechadas: 1, avisadas: 0 });
    expect([...eventos.values()].map((e) => e.resultado)).toEqual(["etiqueta trocada"]);
    expect(rodadasRegistradas).toEqual([{ status: "OK", lastError: null }]);
  });

  it("na última hora deixa UMA nota privada pelo robô, e não repete na conferência seguinte", async () => {
    conversa(1, [{ tipo: 0, haHoras: 23.4 }, { tipo: 1, haHoras: 23 }]);

    expect(await rodar()).toMatchObject({ avisadas: 1 });
    expect(notas).toHaveLength(1);
    expect(notas[0].privado).toBe(true);
    expect(notas[0].texto.startsWith(MARCA_DA_NOTA)).toBe(true);
    expect(etiquetasGravadas).toEqual([]);

    // A nota vira a última mensagem da conversa, e força uma releitura.
    mensagens.get(1)!.push({
      id: proximoId++,
      message_type: 1,
      private: true,
      created_at: S,
      content: notas[0].texto,
    });
    expect(await rodar()).toMatchObject({ avisadas: 0, jaAvisadas: 1 });
    expect(notas).toHaveLength(1);
  });

  it("nota que não saiu não conta como dada: a conferência seguinte tenta de novo", async () => {
    conversa(1, [{ tipo: 0, haHoras: 23.4 }]);

    notaFalha = true;
    expect(await rodar()).toMatchObject({ avisadas: 0, falhas: 1 });
    expect(eventos.size).toBe(0);

    notaFalha = false;
    expect(await rodar()).toMatchObject({ avisadas: 1 });
    expect(notas).toHaveLength(1);
  });

  it("⚠ o cliente escreveu entre a leitura e a escrita: não fecha a janela que ele acabou de reabrir", async () => {
    conversa(1, [{ tipo: 0, haHoras: 30 }]);
    depoisDeLer = (id) => {
      mensagens.get(id)!.push({ id: proximoId++, message_type: 0, created_at: S, content: "oi" });
      depoisDeLer = null;
    };

    expect(await rodar()).toMatchObject({ fechadas: 0, mudaramAoVivo: 1 });
    expect(etiquetasGravadas).toEqual([]);
  });

  it("⚠ a janela é do NÚMERO: o cliente escreveu há 2 h noutra conversa dele na mesma caixa, e esta não fecha", async () => {
    // A equipe abriu uma conversa nova; o cliente tinha escrito na anterior, já resolvida.
    conversa(1, [{ tipo: 1, haHoras: 1 }], { etiquetas: [], contato: 7 });
    conversa(2, [{ tipo: 0, haHoras: 2 }], { status: "resolved", contato: 7 });

    expect(await rodar()).toMatchObject({ fechadas: 0, avisadas: 0 });
    expect(etiquetasGravadas).toEqual([]);
  });

  it("…e a nota sai pela hora da mensagem mais recente, mesmo que seja da outra conversa", async () => {
    conversa(1, [{ tipo: 0, haHoras: 30 }], { contato: 7 });
    conversa(2, [{ tipo: 0, haHoras: 23.5 }], { status: "resolved", contato: 7 });

    expect(await rodar()).toMatchObject({ fechadas: 0, avisadas: 1 });
    expect(notas.map((n) => n.conversa)).toEqual([1]);
  });

  it("conversa do mesmo contato em OUTRA caixa não conta: é outro número", async () => {
    conversa(1, [{ tipo: 0, haHoras: 30 }], { contato: 7 });
    conversa(2, [{ tipo: 0, haHoras: 1 }], { inbox: 34, contato: 7 });

    expect(await rodar()).toMatchObject({ fechadas: 1 });
  });

  it("conversa já marcada como fechada nem é lida", async () => {
    conversa(1, [{ tipo: 0, haHoras: 50 }], { etiquetas: [ETIQUETA_FECHADA] });
    await rodar();
    expect(leituras).toEqual([]);
  });

  it("última mensagem do cliente e recente: descartada pela listagem, sem ler", async () => {
    conversa(1, [{ tipo: 1, haHoras: 6 }, { tipo: 0, haHoras: 2 }]);
    await rodar();
    expect(leituras).toEqual([]);
  });

  it("⚠ conversa de outra caixa não é tocada, nem se a listagem a devolver", async () => {
    conversa(1, [{ tipo: 0, haHoras: 30 }], { inbox: 34 });
    const original = leitor.listarConversas;
    leitor.listarConversas = async (f) => {
      const r = await original({ ...f, inboxId: 34 });
      return f.inboxId === 29 ? r : { conversas: [], total: 0 };
    };
    try {
      await rodar();
    } finally {
      leitor.listarConversas = original;
    }
    expect(etiquetasGravadas).toEqual([]);
    expect(leituras).toEqual([]);
  });

  it("cliente que nunca escreveu: fechada, quando a leitura chega ao começo da conversa", async () => {
    conversa(1, [{ tipo: 3, haHoras: 2 }, { tipo: 1, haHoras: 1 }], { etiquetas: [] });
    expect(await rodar()).toMatchObject({ fechadas: 1 });
    expect(etiquetasGravadas[0].etiquetas).toEqual([ETIQUETA_FECHADA]);
  });

  it("anda para trás além da primeira página para achar o cliente", async () => {
    conversa(1, [
      { tipo: 0, haHoras: 30 },
      ...Array.from({ length: 25 }, (_, i) => ({ tipo: 1, haHoras: 29 - i * 0.1 })),
    ]);
    expect(await rodar()).toMatchObject({ fechadas: 1 });
  });

  it("pendentes também entram, e a listagem é lida até a última página", async () => {
    for (let i = 1; i <= 30; i++) conversa(i, [{ tipo: 0, haHoras: 30 }]);
    conversa(99, [{ tipo: 0, haHoras: 30 }], { status: "pending" });
    expect(await rodar()).toMatchObject({ conversas: 31, fechadas: 31 });
  });

  it("o teto de escritas espalha a correção por várias conferências", async () => {
    const total = TETO_DE_ESCRITAS_POR_RODADA + 5;
    for (let i = 1; i <= total; i++) conversa(i, [{ tipo: 0, haHoras: 30 }]);

    expect(await rodar()).toMatchObject({ fechadas: TETO_DE_ESCRITAS_POR_RODADA, adiadas: 5 });
    expect(await rodar()).toMatchObject({ fechadas: 5, adiadas: 0 });
  });

  it("sem mensagem nova, a conversa não é relida na conferência seguinte", async () => {
    conversa(1, [{ tipo: 0, haHoras: 10 }, { tipo: 1, haHoras: 9 }]);
    await rodar();
    expect(leituras).toEqual([1]);
    await rodar();
    expect(leituras).toEqual([1]);
  });
});
