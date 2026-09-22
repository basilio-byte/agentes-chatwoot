import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatwootApiError } from "@/server/integrations/chatwoot/client";

/**
 * A rodada do aviso de cobrança de ponta a ponta, com banco, ClickUp e Chatwoot
 * simulados: o que sai para o cliente, em que ordem, e quando NADA sai.
 */

// Segunda-feira, 10h em São Paulo.
const AGORA = new Date("2026-09-21T13:00:00Z");
const CAMPO = "3399c6f6-c890-40a6-865e-5a4e810fe8c6";

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

let eventos: Linha[] = [];
let ligada = true;
let chamadas: string[] = [];
let tarefas: Array<Record<string, unknown>> = [];
let donoDaConversa: { id: number | null; nome: string | null } = { id: null, nome: null };
let statusDaConversa = "open";
let automacaoDesatribuiResolvida = true;
let falhaNoEnvio: Error | null = null;
let falhaAoTirarEtiqueta = false;
let esperas: number[] = [];
let configDaCobranca: Record<string, unknown> = {};
let contatoComConversaAberta = false;

vi.mock("@/lib/db", () => ({
  db: {
    integration: {
      findUnique: async () => ({ enabled: ligada, config: configDaCobranca }),
      update: async () => ({}),
    },
    webhookEvent: {
      create: async ({ data }: { data: Omit<Linha, "id" | "createdAt"> & { createdAt?: Date } }) => {
        if (eventos.some((e) => e.provider === data.provider && e.externalId === data.externalId)) {
          throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        }
        const linha = { id: `e${eventos.length + 1}`, createdAt: new Date(), ...data } as Linha;
        eventos.push(linha);
        return linha;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Linha> }) => {
        const linha = eventos.find((e) => e.id === where.id)!;
        Object.assign(linha, data);
        return linha;
      },
      findUnique: async ({ where }: { where: { provider_externalId: { externalId: string } } }) =>
        eventos.find((e) => e.externalId === where.provider_externalId.externalId) ?? null,
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
      count: async ({ where }: { where: { resultado: string; createdAt: { gte: Date } } }) =>
        eventos.filter((e) => e.resultado === where.resultado && e.createdAt >= where.createdAt.gte)
          .length,
    },
  },
}));

vi.mock("@/server/integrations/clickup/sistema", () => ({
  abrirClickUp: async () => ({
    cliente: {
      listarTarefasDaLista: async (lista: string, opcoes: { tags?: string[] }) => {
        chamadas.push(`clickup:listar:${lista}:${opcoes.tags?.join(",")}`);
        return { tasks: tarefas };
      },
      removerTag: async (id: string, tag: string) => {
        if (falhaAoTirarEtiqueta) throw new Error("ClickUp respondeu 500");
        chamadas.push(`clickup:tirar:${id}:${tag}`);
        const t = tarefas.find((x) => x.id === id);
        if (t) t.tags = (t.tags as Array<{ name: string }>).filter((x) => x.name !== tag);
      },
      comentarTarefa: async (id: string, texto: string) => {
        chamadas.push(`clickup:comentar:${id}:${texto}`);
      },
    },
  }),
}));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteComTokenDeUsuario: async () => ({
    baseUrl: "https://chatwoot.test",
    contaId: 1,
    buscarContatos: async () =>
      contatoComConversaAberta
        ? [{ id: 70, nome: "Cliente", telefone: "+5584998765432", identificador: null, caixas: [{ caixaId: 31, sourceId: "src-70" }] }]
        : [],
    criarContato: async () => ({ id: 70, sourceId: "src-70" }),
    vincularContatoACaixa: async () => "src-70",
    conversasDoContato: async () =>
      contatoComConversaAberta ? [{ id: 800, caixaId: 31, status: "open" }] : [],
    criarConversa: async (d: { caixaId: number }) => {
      chamadas.push(`chatwoot:conversa-nova:caixa-${d.caixaId}`);
      return 900;
    },
    enviarMensagem: async (id: number, texto: string, opcoes?: { privado?: boolean }) => {
      if (!opcoes?.privado && falhaNoEnvio) throw falhaNoEnvio;
      chamadas.push(`chatwoot:${opcoes?.privado ? "nota" : "mensagem"}:${id}:${texto.slice(0, 30)}`);
      return { id: 1 };
    },
    obterConversa: async () => ({
      status: statusDaConversa,
      assigneeId: donoDaConversa.id,
      assigneeNome: donoDaConversa.nome,
    }),
    listarAtendentes: async () => [{ id: 44, name: "Laercio Melo", email: "laercio@x.test" }],
    atribuir: async (id: number, d: { assigneeId: number }) => {
      chamadas.push(`chatwoot:atribuir:${id}:${d.assigneeId}`);
      // A automação do Chatwoot que tira o dono de conversa resolvida.
      if (!(automacaoDesatribuiResolvida && statusDaConversa === "resolved")) {
        donoDaConversa = { id: d.assigneeId, nome: "Laercio Melo" };
      }
    },
    alternarStatus: async (id: number, status: string) => {
      chamadas.push(`chatwoot:status:${id}:${status}`);
      statusDaConversa = status;
    },
  }),
}));

const { conferirCobrancas, reiniciarRelogioDaCobranca } = await import("./conferir");

const tarefa = (id: string, etiquetas: string[], celular: unknown = "+55 84 99876 5432", atualizada = "100") => ({
  id,
  name: `Cliente ${id}`,
  url: `https://app.clickup.com/t/${id}`,
  date_updated: atualizada,
  tags: etiquetas.map((name) => ({ name })),
  custom_fields: [{ id: CAMPO, value: celular }],
});

const rodar = (agora = AGORA) =>
  conferirCobrancas(agora, {
    esperar: true,
    forcar: true,
    dormir: async (ms) => {
      esperas.push(ms);
    },
  });

const mensagensAoCliente = () => chamadas.filter((c) => c.startsWith("chatwoot:mensagem"));
const comentarios = () => chamadas.filter((c) => c.startsWith("clickup:comentar"));

beforeEach(() => {
  reiniciarRelogioDaCobranca();
  eventos = [];
  ligada = true;
  chamadas = [];
  tarefas = [];
  donoDaConversa = { id: null, nome: null };
  statusDaConversa = "open";
  automacaoDesatribuiResolvida = true;
  falhaNoEnvio = null;
  falhaAoTirarEtiqueta = false;
  esperas = [];
  // O padrão é "atribuir"; o "resolver" tem bloco próprio no fim.
  configDaCobranca = {};
  contatoComConversaAberta = false;
});

describe("aviso de cobrança por etiqueta", () => {
  it("manda a mensagem da etiqueta, atribui ao Laercio, anota, tira a etiqueta e comenta — nessa ordem", async () => {
    tarefas = [tarefa("t1", ["cobranca-1"])];

    const r = await rodar();

    expect(r).toMatchObject({ acao: "conferido", enviados: 1, falhas: 0 });
    const passos = chamadas.map((c) => c.split(":").slice(0, 2).join(":"));
    expect(passos).toEqual([
      "clickup:listar",
      "chatwoot:conversa-nova",
      "chatwoot:mensagem",
      "chatwoot:atribuir",
      "chatwoot:nota",
      "clickup:tirar",
      "clickup:comentar",
    ]);
    expect(chamadas).toContain("clickup:listar:900701122530:cobranca-1,cobranca-2");
    expect(chamadas).toContain("chatwoot:conversa-nova:caixa-31");
    expect(mensagensAoCliente()[0]).toContain("Olá! Tudo bem? Identificamos");
    expect(chamadas).toContain("chatwoot:atribuir:900:44");
    expect(chamadas).toContain("clickup:tirar:t1:cobranca-1");
    expect(comentarios()[0]).toContain("✅ 1º aviso de cobrança enviado pelo WhatsApp");
    expect(comentarios()[0]).toContain("https://chatwoot.test/app/accounts/1/conversations/900");
    expect(comentarios()[0]).toContain("Conversa atribuída a Laercio Melo.");
    expect(eventos.map((e) => e.resultado)).toEqual(["enviado"]);
  });

  it("a segunda mensagem é a da etiqueta cobranca-2", async () => {
    tarefas = [tarefa("t1", ["cobranca-2"])];
    await rodar();
    expect(mensagensAoCliente()).toEqual(["chatwoot:mensagem:900:Olá! Estamos retomando nosso c"]);
  });

  it("espaça os envios: o primeiro não espera, os seguintes esperam 30 s", async () => {
    tarefas = [tarefa("t2", ["cobranca-1"], undefined, "200"), tarefa("t1", ["cobranca-1"], undefined, "100")];

    const r = await rodar();

    expect(r.enviados).toBe(2);
    // 3 s para conferir cada atribuição; 30 s entre um envio e o próximo.
    expect(esperas.filter((ms) => ms === 30_000)).toEqual([30_000]);
    // Quem espera há mais tempo vai primeiro.
    expect(chamadas.filter((c) => c.startsWith("clickup:tirar"))).toEqual([
      "clickup:tirar:t1:cobranca-1",
      "clickup:tirar:t2:cobranca-1",
    ]);
  });

  it("sem CELULAR: nada sai, a etiqueta fica, e o comentário é UM só em várias rodadas", async () => {
    tarefas = [tarefa("t1", ["cobranca-1"], null)];

    await rodar();
    await rodar();

    expect(mensagensAoCliente()).toEqual([]);
    expect(chamadas.some((c) => c.startsWith("clickup:tirar"))).toBe(false);
    expect(comentarios()).toHaveLength(1);
    expect(comentarios()[0]).toContain("NÃO enviado");
  });

  it("⚠ a etiqueta não saiu depois do envio: a rodada seguinte NÃO reenvia, só tira a etiqueta", async () => {
    tarefas = [tarefa("t1", ["cobranca-1"])];
    falhaAoTirarEtiqueta = true;
    await rodar();
    expect(mensagensAoCliente()).toHaveLength(1);
    expect(comentarios()[0]).toContain("não consegui tirar a etiqueta");

    falhaAoTirarEtiqueta = false;
    const r = await rodar();

    expect(r.jaEnviados).toBe(1);
    expect(mensagensAoCliente()).toHaveLength(1);
    expect(chamadas).toContain("clickup:tirar:t1:cobranca-1");
  });

  it("reserva abandonada (o processo caiu no meio): não reenvia, tira a etiqueta e pede para conferir", async () => {
    tarefas = [tarefa("t1", ["cobranca-1"])];
    eventos.push({
      id: "velha",
      provider: "COBRANCA",
      externalId: "envio:t1:cobranca-1:2026-09-21T12:00:00.000Z:abc",
      eventType: "cobranca-1",
      payload: {},
      resultado: "reservado",
      detalhe: null,
      createdAt: new Date(AGORA.getTime() - 20 * 60_000),
    });

    await rodar();

    expect(mensagensAoCliente()).toEqual([]);
    expect(eventos[0].resultado).toBe("incerto");
    expect(comentarios()[0]).toContain("PODE ter chegado");
    expect(chamadas).toContain("clickup:tirar:t1:cobranca-1");
  });

  it("teto por hora atingido: para a rodada sem mandar", async () => {
    tarefas = [tarefa("t1", ["cobranca-1"])];
    for (let i = 0; i < 60; i++) {
      eventos.push({
        id: `x${i}`,
        provider: "COBRANCA",
        externalId: `envio:outra${i}:cobranca-1:z`,
        eventType: "cobranca-1",
        payload: {},
        resultado: "enviado",
        detalhe: null,
        createdAt: new Date(),
      });
    }

    const r = await rodar();

    expect(r.paradaPeloTeto).toBe(true);
    expect(mensagensAoCliente()).toEqual([]);
  });

  it("Chatwoot recusa o número (4xx): comenta uma vez e não insiste nas rodadas seguintes", async () => {
    tarefas = [tarefa("t1", ["cobranca-1"])];
    falhaNoEnvio = new ChatwootApiError(422, "phone number invalid");

    await rodar();
    await rodar();

    expect(comentarios()).toHaveLength(1);
    expect(comentarios()[0]).toContain("recusou o envio (422)");
    // Uma reserva só: a segunda rodada nem tentou.
    expect(eventos.filter((e) => e.externalId.startsWith("envio:"))).toHaveLength(1);
    expect(chamadas.some((c) => c.startsWith("clickup:tirar"))).toBe(false);
  });

  it("Chatwoot fora do ar (5xx): não comenta, e tenta de novo na rodada seguinte", async () => {
    tarefas = [tarefa("t1", ["cobranca-1"])];
    falhaNoEnvio = new ChatwootApiError(502, "bad gateway");
    await rodar();
    expect(comentarios()).toEqual([]);

    falhaNoEnvio = null;
    const r = await rodar();
    expect(r.enviados).toBe(1);
  });

  it("conversa que já está com alguém: não tira dela, e o comentário diz com quem ficou", async () => {
    tarefas = [tarefa("t1", ["cobranca-1"])];
    donoDaConversa = { id: 12, nome: "Wellen Kelly" };

    await rodar();

    expect(chamadas.some((c) => c.startsWith("chatwoot:atribuir"))).toBe(false);
    expect(eventos[0].detalhe).toContain("já estava com Wellen Kelly");
  });

  it("⚠ conversa resolvida (a caixa 31 devolve a última): reabre ANTES de atribuir, e a atribuição fica", async () => {
    // Teste real de 22/09/2026: a mensagem entrou na conversa resolvida 14029, a
    // atribuição ao Laercio foi desfeita pela automação no mesmo segundo, e a
    // conversa ficou fora da fila.
    tarefas = [tarefa("t1", ["cobranca-1"])];
    statusDaConversa = "resolved";

    await rodar();

    const i = (prefixo: string) => chamadas.findIndex((c) => c.startsWith(prefixo));
    expect(chamadas).toContain("chatwoot:status:900:open");
    expect(i("chatwoot:status")).toBeLessThan(i("chatwoot:atribuir"));
    expect(donoDaConversa.id).toBe(44);
    expect(comentarios()[0]).toContain("Conversa atribuída a Laercio Melo.");
  });

  it("atribuição desfeita logo depois (outra automação): o comentário NÃO diz que atribuiu", async () => {
    tarefas = [tarefa("t1", ["cobranca-1"])];

    const r = await conferirCobrancas(AGORA, {
      esperar: true,
      forcar: true,
      // Alguma automação tira o dono enquanto o sistema espera para conferir.
      dormir: async () => {
        donoDaConversa = { id: null, nome: null };
      },
    });

    expect(r.enviados).toBe(1);
    expect(comentarios()[0]).not.toContain("Conversa atribuída a");
    expect(comentarios()[0]).toContain("desfez");
  });

  it("desligada ou fora do horário: nem lê o ClickUp", async () => {
    ligada = false;
    expect((await rodar()).acao).toBe("desligada");

    ligada = true;
    reiniciarRelogioDaCobranca();
    const sabado = await conferirCobrancas(new Date("2026-09-26T13:00:00Z"), { esperar: true });
    expect(sabado.acao).toBe("fora do horário");
    expect(chamadas).toEqual([]);
  });

  it("confere de 30 em 30 minutos, e não se sobrepõe", async () => {
    tarefas = [];
    await conferirCobrancas(AGORA, { esperar: true });
    const logo = await conferirCobrancas(new Date(AGORA.getTime() + 10 * 60_000), { esperar: true });
    const depois = await conferirCobrancas(new Date(AGORA.getTime() + 31 * 60_000), { esperar: true });
    expect(logo.acao).toBe("cedo");
    expect(depois.acao).toBe("conferido");
  });
});

describe("com a opção \"resolver\", a automação resolve a conversa depois do envio", () => {
  const status = () => chamadas.filter((c) => c.startsWith("chatwoot:status"));

  it("config gravada sem a opção continua ATRIBUINDO: nada muda para quem já usa", async () => {
    configDaCobranca = {};
    tarefas = [tarefa("t1", ["cobranca-1"])];

    await rodar();

    expect(chamadas.some((c) => c.startsWith("chatwoot:atribuir"))).toBe(true);
    expect(chamadas.some((c) => c.endsWith(":resolved"))).toBe(false);
  });

  it("manda, anota, RESOLVE e comenta — sem atribuir a ninguém", async () => {
    configDaCobranca = { aposEnviar: "resolver" };
    tarefas = [tarefa("t1", ["cobranca-1"])];

    const r = await rodar();

    expect(r.enviados).toBe(1);
    expect(chamadas.some((c) => c.startsWith("chatwoot:atribuir"))).toBe(false);
    const nota = chamadas.findIndex((c) => c.startsWith("chatwoot:nota:900"));
    const resolver = chamadas.indexOf("chatwoot:status:900:resolved");
    expect(nota).toBeGreaterThan(-1);
    expect(resolver).toBeGreaterThan(nota);
    expect(comentarios()[0]).toContain("Conversa resolvida pela automação.");
    expect(comentarios()[0]).not.toContain("atribuída");
    expect(tarefas[0].tags).toEqual([]);
  });

  it("a conversa resolvida que a caixa 31 devolve continua resolvida, sem reabrir", async () => {
    configDaCobranca = { aposEnviar: "resolver" };
    statusDaConversa = "resolved";
    tarefas = [tarefa("t1", ["cobranca-2"])];

    await rodar();

    expect(status()).toEqual([]);
    expect(comentarios()[0]).toContain("Conversa resolvida pela automação.");
  });

  it("⚠ conversa com dono fica com ele: não resolve o atendimento de ninguém", async () => {
    configDaCobranca = { aposEnviar: "resolver" };
    donoDaConversa = { id: 7, nome: "Wellen Kelly" };
    tarefas = [tarefa("t1", ["cobranca-1"])];

    await rodar();

    expect(status()).toEqual([]);
    expect(comentarios()[0]).toContain("estava com Wellen Kelly e continua com ela");
  });

  it("⚠ conversa que já estava ABERTA antes do envio fica aberta: pode ter cliente esperando", async () => {
    configDaCobranca = { aposEnviar: "resolver" };
    contatoComConversaAberta = true;
    tarefas = [tarefa("t1", ["cobranca-1"])];

    await rodar();

    expect(mensagensAoCliente()[0]).toMatch(/^chatwoot:mensagem:800:/);
    expect(status()).toEqual([]);
    expect(comentarios()[0]).toContain("já estava aberta");
  });

  it("resolver falhou: o comentário não diz que resolveu, e a etiqueta sai do mesmo jeito", async () => {
    configDaCobranca = { aposEnviar: "resolver" };
    tarefas = [tarefa("t1", ["cobranca-1"])];

    const r = await conferirCobrancas(AGORA, {
      esperar: true,
      forcar: true,
      // Uma automação do Chatwoot reabre a conversa logo depois.
      dormir: async () => {
        statusDaConversa = "open";
      },
    });

    expect(r.enviados).toBe(1);
    expect(comentarios()[0]).not.toContain("resolvida pela automação");
    expect(comentarios()[0]).toContain('ficou "open"');
    expect(tarefas[0].tags).toEqual([]);
  });
});

