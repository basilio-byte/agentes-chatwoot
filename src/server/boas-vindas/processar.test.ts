import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificaMeApiError, NotificaMeRedeError } from "@/server/integrations/notificame/client";

/**
 * O clique na macro de ponta a ponta, com banco, NotificaMe e Chatwoot simulados:
 * o que sai para o cliente, quantas vezes, e o que a pessoa que clicou lê quando
 * NADA sai. Só dados fictícios.
 */

// Terça-feira, 11h em São Paulo.
const INICIO = new Date("2026-11-03T14:02:51Z");

type Linha = {
  id: string;
  provider: string;
  externalId: string;
  eventType: string;
  payload: unknown;
  resultado: string | null;
  detalhe: string | null;
  createdAt: Date;
};
type Conversa = {
  status: string;
  assigneeId: number | null;
  assigneeTipo: string | null;
  assigneeNome: string | null;
};

let agoraDoTeste = INICIO;
let eventos: Linha[] = [];
let ligada = true;
let temCredencial = true;
let configGravada: Record<string, unknown> = {};
let estadoDaIntegracao: Record<string, unknown> = {};
let temLeitor = true;
let temRobo = true;
let conversasDoContato: Array<{ id: number; caixaId: number | null; status: string }> = [];
let conversas: Record<number, Conversa> = {};
let desfazAtribuicoes = 0;
let chamadas: string[] = [];
let notas: Array<{ por: "robo" | "usuario"; conversa: number; texto: string }> = [];
let envios: Array<Record<string, unknown>> = [];
let falhaNoEnvio: Error | null = null;
let corpoDoTemplate: string | null = null;

vi.mock("@/lib/crypto", () => ({ decifrar: () => "token-de-teste" }));

vi.mock("@/lib/db", () => ({
  db: {
    integration: {
      findUnique: async () => ({
        enabled: ligada,
        config: configGravada,
        credential: temCredencial ? { ciphertext: "x", iv: "y", authTag: "z" } : null,
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        estadoDaIntegracao = { ...estadoDaIntegracao, ...data };
        return {};
      },
    },
    webhookEvent: {
      create: async ({ data }: { data: Omit<Linha, "id" | "createdAt"> }) => {
        if (eventos.some((e) => e.provider === data.provider && e.externalId === data.externalId)) {
          throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        }
        const linha = { id: `e${eventos.length + 1}`, createdAt: agoraDoTeste, ...data } as Linha;
        eventos.push(linha);
        return linha;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Linha> }) => {
        const linha = eventos.find((e) => e.id === where.id)!;
        Object.assign(linha, data);
        return linha;
      },
      findFirst: async ({
        where,
      }: {
        where: { externalId: { startsWith: string }; resultado: { in: string[] }; createdAt: { gte: Date } };
      }) =>
        eventos
          .filter(
            (e) =>
              e.externalId.startsWith(where.externalId.startsWith) &&
              where.resultado.in.includes(e.resultado ?? "") &&
              e.createdAt >= where.createdAt.gte,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
      count: async ({
        where,
      }: {
        where: { externalId: { startsWith: string }; resultado: { in: string[] }; createdAt: { gte: Date } };
      }) =>
        eventos.filter(
          (e) =>
            e.externalId.startsWith(where.externalId.startsWith) &&
            where.resultado.in.includes(e.resultado ?? "") &&
            e.createdAt >= where.createdAt.gte,
        ).length,
    },
  },
}));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteComTokenDeUsuario: async () =>
    temLeitor
      ? {
          conversasDoContato: async () => conversasDoContato,
          obterConversa: async (id: number) => ({ ...conversas[id] }),
          alternarStatus: async (id: number, status: string) => {
            chamadas.push(`status:${id}:${status}`);
            conversas[id].status = status;
          },
          atribuir: async (id: number, d: { assigneeId: number }) => {
            chamadas.push(`atribuir:${id}:${d.assigneeId}`);
            // A automação do Chatwoot que tira o dono logo depois de atribuir.
            if (desfazAtribuicoes > 0) {
              desfazAtribuicoes -= 1;
              return;
            }
            Object.assign(conversas[id], { assigneeId: d.assigneeId, assigneeTipo: "User", assigneeNome: "Alan Teste" });
          },
          enviarMensagem: async (conversa: number, texto: string) => {
            notas.push({ por: "usuario", conversa, texto });
            return { id: 1 };
          },
        }
      : null,
  clienteDoAgente: async () =>
    temRobo
      ? {
          enviarMensagem: async (conversa: number, texto: string) => {
            notas.push({ por: "robo", conversa, texto });
            return { id: 2 };
          },
        }
      : null,
}));

vi.mock("@/server/integrations/chatwoot/porta", () => ({
  portaDaCaixa: async () => (temRobo ? "agente-porta" : null),
}));

const { processarMacro } = await import("./processar");

const macro = (sobre: Record<string, unknown> = {}, telefone: string | null = "+558499990000") => ({
  event: "macro.executed",
  id: 5001,
  inbox_id: 31,
  status: "resolved",
  meta: {
    sender: { id: 77, name: "Maria Teste", phone_number: telefone, identifier: null },
    assignee: { id: 12, name: "Alan Teste" },
    assignee_type: "User",
  },
  ...sobre,
});

const notificame = () => ({
  enviarTemplate: async (envio: Record<string, unknown>) => {
    envios.push(envio);
    if (falhaNoEnvio) throw falhaNoEnvio;
    return { id: `msg-${envios.length}`, status: "queued" };
  },
  listarTemplates: async () =>
    corpoDoTemplate
      ? [{ nome: "template_diego2", idioma: "pt_BR", status: "APPROVED", categoria: "UTILITY", corpo: corpoDoTemplate }]
      : [],
});

const clicar = (corpo: unknown = macro(), quando = agoraDoTeste) =>
  processarMacro(corpo, { agora: quando, dormir: async () => {}, notificame });

const notasDa = (conversa: number) => notas.filter((n) => n.conversa === conversa);

beforeEach(() => {
  agoraDoTeste = INICIO;
  eventos = [];
  ligada = true;
  temCredencial = true;
  configGravada = { canalId: "canal-teste" };
  estadoDaIntegracao = {};
  temLeitor = true;
  temRobo = true;
  // A conversa em que se clicou (caixa 31) e a do cliente na caixa do WhatsApp oficial (29).
  conversasDoContato = [
    { id: 5001, caixaId: 31, status: "resolved" },
    { id: 900, caixaId: 29, status: "resolved" },
  ];
  conversas = {
    5001: { status: "resolved", assigneeId: 12, assigneeTipo: "User", assigneeNome: "Alan Teste" },
    900: { status: "resolved", assigneeId: null, assigneeTipo: null, assigneeNome: null },
  };
  desfazAtribuicoes = 0;
  chamadas = [];
  notas = [];
  envios = [];
  falhaNoEnvio = null;
  corpoDoTemplate = "Olá, {{texto}}.\n\nConforme solicitado, iniciamos seu atendimento pelo WhatsApp.";
});

describe("o clique que dá certo", () => {
  it("manda UM template com o nome do contato, reabre e atribui ANTES, e a nota sai pelo robô", async () => {
    const r = await clicar();

    expect(r.resultado).toBe("enviado");
    expect(envios).toHaveLength(1);
    expect(envios[0]).toMatchObject({
      canalId: "canal-teste",
      para: "558499990000",
      template: "template_diego2",
      idioma: "pt_BR",
      parametros: [{ nome: "texto", texto: "Maria Teste" }],
    });

    // Na conversa do CLIENTE (caixa 29), não na do clique; reabre antes de atribuir.
    expect(chamadas).toEqual(["status:900:open", "atribuir:900:12"]);

    expect(notasDa(900)).toHaveLength(1);
    const nota = notasDa(900)[0];
    expect(nota.por).toBe("robo");
    expect(nota.texto.startsWith('Template enviado: "template_diego2"\n\nMensagem:\n\nOlá, Maria Teste.')).toBe(true);
    expect(nota.texto).toContain("Conversa atribuída a Alan Teste.");
    expect(notasDa(5001)).toHaveLength(0);
  });

  it("a entrega fica gravada como enviada, sem nome nem telefone, e nada fica 'reservado'", async () => {
    await clicar();

    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ provider: "BOAS_VINDAS", resultado: "enviado" });
    const tudo = JSON.stringify(eventos);
    expect(tudo).not.toContain("999990000");
    expect(tudo).not.toContain("Maria");
    expect(eventos.some((e) => e.resultado === "reservado")).toBe(false);
    expect(estadoDaIntegracao).toMatchObject({ status: "OK", lastError: null });
  });

  it("⚠ conversa que já tem PESSOA como dona não é tirada dela", async () => {
    conversas[900] = { status: "open", assigneeId: 5, assigneeTipo: "User", assigneeNome: "Joana Teste" };

    const r = await clicar();

    expect(r.resultado).toBe("enviado");
    expect(chamadas).toEqual([]);
    expect(notasDa(900)[0].texto).toContain("A conversa já estava com Joana Teste e continua com essa pessoa.");
  });

  it("o nosso robô como dono não conta: a conversa pendente vai para quem clicou", async () => {
    conversas[900] = { status: "pending", assigneeId: 4, assigneeTipo: "AgentBot", assigneeNome: "Seahub Coworking" };

    await clicar();

    expect(chamadas).toEqual(["status:900:open", "atribuir:900:12"]);
  });

  it("automação do Chatwoot que desfaz a atribuição: tenta mais uma vez e a nota diz o que ficou", async () => {
    desfazAtribuicoes = 1;
    await clicar();
    expect(chamadas).toEqual(["status:900:open", "atribuir:900:12", "atribuir:900:12"]);
    expect(notasDa(900)[0].texto).toContain("Conversa atribuída a Alan Teste.");
  });

  it("se a automação desfaz sempre, a nota avisa — e o template já saiu", async () => {
    desfazAtribuicoes = 9;
    const r = await clicar();
    expect(r.resultado).toBe("enviado");
    expect(notasDa(900)[0].texto).toContain("provavelmente uma automação do Chatwoot desfez");
    expect(r.detalhe).toContain("automação do Chatwoot");
  });

  it("sem conversa do cliente na caixa 29, a nota fica na conversa do clique e nada é reaberto", async () => {
    conversasDoContato = [{ id: 5001, caixaId: 31, status: "resolved" }];

    const r = await clicar();

    expect(r.resultado).toBe("enviado");
    expect(chamadas).toEqual([]);
    expect(notasDa(5001)).toHaveLength(1);
    expect(notasDa(5001)[0].texto).toContain("ainda não tem conversa na caixa 29");
  });

  it("sem o token de leitura do Chatwoot o template sai, e a nota (pelo robô) diz o que faltou", async () => {
    temLeitor = false;

    const r = await clicar();

    expect(r.resultado).toBe("enviado");
    expect(envios).toHaveLength(1);
    expect(chamadas).toEqual([]);
    expect(notasDa(5001)[0].texto).toContain("falta o token de leitura em Integrações → Chatwoot");
  });

  it("sem conseguir ler o template na NotificaMe, a nota não inventa o texto", async () => {
    corpoDoTemplate = null;
    await clicar();
    expect(notasDa(900)[0].texto).toContain("(não consegui ler o texto do template na NotificaMe)");
  });
});

describe("⚠ um clique, um envio — o defeito que trouxe este módulo", () => {
  it("o mesmo número duas vezes seguidas: a segunda NÃO sai, e quem clicou lê o motivo", async () => {
    await clicar();
    const segunda = await clicar();

    expect(segunda.resultado).toBe("repetido");
    expect(envios).toHaveLength(1);
    const aviso = notasDa(5001).find((n) => n.texto.includes("NÃO reenviado"));
    expect(aviso?.texto).toContain("espera 10 min");
  });

  it("o número com o nono dígito é o mesmo número", async () => {
    await clicar(macro({}, "+558499990000"));
    const segunda = await clicar(macro({}, "+5584999990000"));
    expect(segunda.resultado).toBe("repetido");
    expect(envios).toHaveLength(1);
  });

  it("duas entregas AO MESMO TEMPO: só uma envia (a trava é a do banco)", async () => {
    const [a, b] = await Promise.all([clicar(), clicar()]);

    expect(envios).toHaveLength(1);
    expect([a.resultado, b.resultado].sort()).toEqual(["enviado", "repetido"]);
  });

  it("passado o intervalo, o mesmo número recebe de novo", async () => {
    await clicar();
    const depois = await clicar(macro(), new Date(INICIO.getTime() + 11 * 60_000));
    agoraDoTeste = new Date(INICIO.getTime() + 11 * 60_000);

    expect(depois.resultado).toBe("enviado");
    expect(envios).toHaveLength(2);
  });

  it("⚠ o clique logo depois da virada do intervalo também é segurado (a chave única sozinha deixaria passar)", async () => {
    // Os intervalos de 10 minutos viram às 14:10:00: 14:09:30 e 14:10:30 têm chaves diferentes.
    const antes = new Date("2026-11-03T14:09:30Z");
    const depois = new Date("2026-11-03T14:10:30Z");
    agoraDoTeste = antes;
    await clicar(macro(), antes);
    agoraDoTeste = depois;
    const segunda = await clicar(macro(), depois);

    expect(segunda.resultado).toBe("repetido");
    expect(envios).toHaveLength(1);
  });

  it("números diferentes não se seguram", async () => {
    await clicar(macro({}, "+558499990000"));
    await clicar(macro({}, "+558499990001"));
    expect(envios).toHaveLength(2);
  });

  it("teto por hora: passou dele, nada sai", async () => {
    configGravada = { canalId: "canal-teste", tetoPorHora: 2 };
    for (const n of [1, 2]) {
      eventos.push({
        id: `antigo${n}`,
        provider: "BOAS_VINDAS",
        externalId: `envio:abc${n}:1`,
        eventType: "x",
        payload: {},
        resultado: "enviado",
        detalhe: null,
        createdAt: new Date(INICIO.getTime() - 10 * 60_000),
      });
    }

    const r = await clicar();

    expect(r.resultado).toBe("teto");
    expect(envios).toHaveLength(0);
    expect(notasDa(5001)[0].texto).toContain("teto de 2 envios por hora");
  });
});

describe("quando a NotificaMe falha", () => {
  it("⚠ recusa (4xx): nada saiu, quem clicou lê o motivo, e o número fica LIVRE para tentar de novo", async () => {
    falhaNoEnvio = new NotificaMeApiError(400, "NotificaMe respondeu 400: Template não encontrado");

    const r = await clicar();

    expect(r.resultado).toBe("falhou");
    expect(notasDa(5001)[0].texto).toContain("NÃO enviado. A NotificaMe recusou o pedido");
    expect(estadoDaIntegracao).toMatchObject({ status: "ERROR" });
    expect(eventos.some((e) => e.externalId.startsWith("falha:"))).toBe(true);

    // Corrigido o motivo, o mesmo número volta a poder receber — sem esperar.
    falhaNoEnvio = null;
    const nova = await clicar();
    expect(nova.resultado).toBe("enviado");
    expect(envios).toHaveLength(2);
  });

  it("⚠ rede ou 5xx: a mensagem PODE ter saído — a nota diz isso e o reenvio fica SEGURADO", async () => {
    falhaNoEnvio = new NotificaMeRedeError("socket hang up");

    const r = await clicar();

    expect(r.resultado).toBe("incerto");
    expect(notasDa(5001)[0].texto).toContain("PODE ter saído");
    expect(estadoDaIntegracao).toMatchObject({ status: "ERROR" });

    // Repetir às cegas é o defeito de origem: mesmo sem falha agora, o reenvio espera.
    falhaNoEnvio = null;
    const nova = await clicar();
    expect(nova.resultado).toBe("repetido");
    expect(envios).toHaveLength(1);
  });
});

describe("quando NADA sai, quem clicou fica sabendo", () => {
  it("desligado: não envia e a nota diz onde ligar", async () => {
    ligada = false;

    const r = await clicar();

    expect(r.resultado).toBe("desligado");
    expect(envios).toHaveLength(0);
    expect(notasDa(5001)[0].texto).toContain("desligado em Integrações → Boas-vindas");
    // Desligado de propósito não é erro da integração.
    expect(estadoDaIntegracao).toEqual({});
  });

  it("sem token cadastrado, ou sem canal: não envia", async () => {
    temCredencial = false;
    expect((await clicar()).resultado).toBe("falhou");

    temCredencial = true;
    configGravada = {};
    expect((await clicar()).resultado).toBe("falhou");

    expect(envios).toHaveLength(0);
    expect(notasDa(5001)).toHaveLength(2);
    expect(notasDa(5001)[0].texto).toContain("Falta o token ou o canal da NotificaMe");
  });

  it("contato sem telefone válido: não envia", async () => {
    const r = await clicar(macro({}, null));

    expect(r.resultado).toBe("falhou");
    expect(envios).toHaveLength(0);
    expect(notasDa(5001)[0].texto).toContain("não tem um telefone válido");
  });

  it("corpo que não é de macro: ignorado e registrado, sem enviar nada", async () => {
    const r = await clicar({ event: "message_created", id: 1 });

    expect(r.resultado).toBe("ignorado");
    expect(envios).toHaveLength(0);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ resultado: "ignorado", eventType: "macro ignorada" });
  });
});
