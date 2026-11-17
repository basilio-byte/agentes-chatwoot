import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A limpeza dos campos do contato de ponta a ponta, com banco e Chatwoot
 * simulados: registrada na resolução, feita 15 min depois, só com a conversa
 * ainda resolvida.
 */

const AGORA = new Date("2026-11-17T18:00:00Z");
const MIN = 60_000;

type Linha = {
  id: string;
  provider: string;
  externalId: string;
  resultado: string | null;
  detalhe?: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
};

let configChatwoot: Record<string, unknown>;
let linhas: Linha[];
let aoVivo: { status: string; contactId: number | null };
let outras: { id: number; status: string }[];
let atributos: Record<string, unknown>;
let gravados: Record<string, unknown>[];
let falha: Error | null;

const casa = (l: Linha, where: Record<string, unknown>) =>
  Object.entries(where).every(([campo, cond]) => {
    const valor = (l as unknown as Record<string, unknown>)[campo];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { lt?: Date; lte?: Date; gt?: Date; startsWith?: string };
      if (c.lt) return (valor as Date) < c.lt;
      if (c.lte) return (valor as Date) <= c.lte;
      if (c.gt) return (valor as Date) > c.gt;
      if (c.startsWith) return String(valor).startsWith(c.startsWith);
    }
    return valor === cond;
  });

vi.mock("@/lib/db", () => ({
  db: {
    integration: { findUnique: async () => ({ config: configChatwoot }) },
    webhookEvent: {
      create: async ({ data }: { data: Omit<Linha, "id" | "createdAt"> }) => {
        if (linhas.some((l) => l.externalId === data.externalId)) {
          throw Object.assign(new Error("Unique"), { code: "P2002" });
        }
        linhas.push({ ...data, id: `l${linhas.length + 1}`, createdAt: AGORA });
        return {};
      },
      findMany: async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
        linhas.filter((l) => casa(l, where)).slice(0, take),
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        linhas.find((l) => casa(l, where)) ?? null,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Linha> }) => {
        const alvo = linhas.filter((l) => casa(l, where));
        alvo.forEach((l) => Object.assign(l, data));
        return { count: alvo.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Linha> }) => {
        const l = linhas.find((x) => x.id === where.id)!;
        Object.assign(l, data);
        return l;
      },
    },
  },
}));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteDeLeitura: async () => ({
    cliente: {
      obterConversa: async () => {
        if (falha) throw falha;
        return aoVivo;
      },
      conversasDoContato: async () => outras,
      obterContato: async () => ({ atributos }),
      definirAtributosDoContato: async (_id: number, novos: Record<string, unknown>) => {
        gravados.push(novos);
      },
    },
  }),
}));

const { limparContatosResolvidos, registrarLimpezaDoContato, reiniciarRelogioDaLimpeza } =
  await import("./conferir");
const { ChatwootApiError } = await import("@/server/integrations/chatwoot/client");

const resolucao = (id = 10954, instante = Math.floor(AGORA.getTime() / 1000)) => ({
  event: "conversation_status_changed",
  id,
  status: "resolved",
  inbox_id: 29,
  updated_at: instante,
});

/** Uma pendente registrada há `minutos`. */
function pendente(minutos: number, conversa = 10954, id = "p1") {
  linhas.push({
    id,
    provider: "LIMPEZA_CONTATO",
    externalId: `conversa:${conversa}:${minutos}`,
    resultado: "pendente",
    payload: { conversa, inbox: 29 },
    createdAt: new Date(AGORA.getTime() - minutos * MIN),
  });
}

const rodar = () => limparContatosResolvidos(AGORA, { forcar: true });

beforeEach(() => {
  reiniciarRelogioDaLimpeza();
  configChatwoot = { baseUrl: "https://chatwoot.test", limpezaDoContato: { ligada: true } };
  linhas = [];
  aoVivo = { status: "resolved", contactId: 77 };
  outras = [{ id: 10954, status: "resolved" }];
  atributos = {
    canal: "Site",
    campanha: "Hub Empreendedoras",
    observaes: "ligar depois",
    email: "cliente@exemplo.com",
    cpf: "12345678909",
    ramo_de_atividade: "Tecnologia",
  };
  gravados = [];
  falha = null;
});

describe("na resolução", () => {
  it("ligada: registra a limpeza pendente, sem nome nem telefone", async () => {
    expect(await registrarLimpezaDoContato(resolucao(), AGORA.getTime())).toBe(true);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ provider: "LIMPEZA_CONTATO", resultado: "pendente" });
    expect(linhas[0].payload).toEqual({
      conversa: 10954,
      inbox: 29,
      resolvidaEm: Math.floor(AGORA.getTime() / 1000),
    });
  });

  it("a reentrega do Chatwoot não registra de novo", async () => {
    await registrarLimpezaDoContato(resolucao(), AGORA.getTime());
    expect(await registrarLimpezaDoContato(resolucao(), AGORA.getTime())).toBe(false);
    expect(linhas).toHaveLength(1);
  });

  it("desligada, ou evento que não é resolução: nada", async () => {
    configChatwoot = { limpezaDoContato: { ligada: false } };
    expect(await registrarLimpezaDoContato(resolucao(), AGORA.getTime())).toBe(false);
    configChatwoot = { limpezaDoContato: { ligada: true } };
    expect(
      await registrarLimpezaDoContato({ ...resolucao(), status: "open" }, AGORA.getTime()),
    ).toBe(false);
    expect(linhas).toEqual([]);
  });
});

describe("15 minutos depois", () => {
  it("limpa só os campos da lista que estão preenchidos; e-mail, CPF e ramo ficam", async () => {
    pendente(16);
    const r = await rodar();

    expect(r.limpas).toBe(1);
    expect(gravados).toEqual([{ canal: null, campanha: null, observaes: null }]);
    expect(linhas[0]).toMatchObject({
      resultado: "limpa",
      detalhe: "campos limpos: canal, campanha, observaes",
    });
  });

  it("antes dos 15 minutos não mexe", async () => {
    pendente(10);
    await rodar();
    expect(gravados).toEqual([]);
    expect(linhas[0].resultado).toBe("pendente");
  });

  it("a conversa foi reaberta: não limpa", async () => {
    pendente(16);
    aoVivo = { status: "open", contactId: 77 };
    await rodar();
    expect(gravados).toEqual([]);
    expect(linhas[0]).toMatchObject({ resultado: "pulada" });
  });

  it("o contato tem outra conversa em andamento: não limpa", async () => {
    pendente(16);
    outras = [...outras, { id: 15100, status: "open" }];
    await rodar();
    expect(gravados).toEqual([]);
    expect(linhas[0].detalhe).toMatch(/#15100/);
  });

  it("nada da lista preenchido: registra e não grava", async () => {
    pendente(16);
    atributos = { email: "cliente@exemplo.com" };
    await rodar();
    expect(gravados).toEqual([]);
    expect(linhas[0].resultado).toBe("nada a limpar");
  });

  it("resolvida de novo depois: a limpeza vai com a resolução mais nova", async () => {
    pendente(30, 10954, "antiga");
    pendente(16, 10954, "nova");
    await rodar();
    expect(linhas.find((l) => l.id === "antiga")).toMatchObject({ resultado: "pulada" });
    expect(linhas.find((l) => l.id === "nova")).toMatchObject({ resultado: "limpa" });
    expect(gravados).toHaveLength(1);
  });

  it("desligada: as pendentes ficam onde estão", async () => {
    pendente(16);
    configChatwoot = { limpezaDoContato: { ligada: false } };
    expect(await rodar()).toEqual({ acao: "desligada" });
    expect(linhas[0].resultado).toBe("pendente");
  });

  it("pendente há mais de 48 h expira sem limpar", async () => {
    pendente(49 * 60);
    const r = await rodar();
    expect(r.expiradas).toBe(1);
    expect(linhas[0].resultado).toBe("expirada");
    expect(gravados).toEqual([]);
  });

  it("Chatwoot fora do ar: volta para a fila", async () => {
    pendente(16);
    falha = new Error("socket hang up");
    await rodar();
    expect(linhas[0].resultado).toBe("pendente");
  });

  it("recusa clara do Chatwoot (conversa que não existe): fecha como falha, sem voltar à fila", async () => {
    pendente(16);
    falha = new ChatwootApiError(404, "not found");
    await rodar();
    expect(linhas[0].resultado).toBe("falhou");
  });
});
