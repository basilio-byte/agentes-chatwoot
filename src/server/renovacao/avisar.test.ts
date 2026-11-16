import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatwootApiError } from "@/server/integrations/chatwoot/client";

/**
 * A rodada do WhatsApp da renovação de ponta a ponta, com banco, ClickUp e
 * Chatwoot simulados: o que sai para o cliente, em que ordem, e quando NADA sai.
 */

// Segunda-feira, 10h em São Paulo.
const AGORA = new Date("2026-11-16T13:00:00Z");
const ENTROU = AGORA.getTime() - 48 * 3_600_000;
const CAMPO_CELULAR = "3399c6f6-c890-40a6-865e-5a4e810fe8c6";
const CAMPO_CATEGORIA = "9acf7c8a-c46d-4bc3-90df-07a1540cb196";

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
let config: Record<string, unknown> = {};
let chamadas: string[] = [];
let listagem: Array<Record<string, unknown>> = [];
let desde: Record<string, { status: string | null; desde: number | null }> = {};
let clickupAberto = 0;
let semTokenDoChatwoot = false;
let donoDaConversa: { id: number | null; nome: string | null } = { id: null, nome: null };
let statusDaConversa = "open";
let automacaoDesatribui = false;
let falhaNoEnvio: Error | null = null;
let falhaAoCriarConversa: Error | null = null;
let esperas: number[] = [];
let ausencias: Array<{ nome: string; substituto: string; ate: string }> = [];

vi.mock("@/lib/db", () => ({
  db: {
    webhookEvent: {
      create: async ({ data }: { data: Omit<Linha, "id" | "createdAt"> & { createdAt?: Date } }) => {
        if (eventos.some((e) => e.provider === data.provider && e.externalId === data.externalId)) {
          throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        }
        const linha = { id: `e${eventos.length + 1}`, createdAt: new Date(), ...data } as Linha;
        eventos.push(linha);
        return linha;
      },
      findUnique: async ({
        where,
      }: {
        where: { provider_externalId: { provider: string; externalId: string } };
      }) =>
        eventos.find(
          (e) =>
            e.provider === where.provider_externalId.provider &&
            e.externalId === where.provider_externalId.externalId,
        ) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<Linha> }) =>
        Object.assign(eventos.find((e) => e.id === where.id)!, data),
      delete: async ({ where }: { where: { id: string } }) => {
        eventos = eventos.filter((e) => e.id !== where.id);
      },
      upsert: async ({ where, create, update }: {
        where: { provider_externalId: { provider: string; externalId: string } };
        create: Omit<Linha, "id" | "createdAt">;
        update: Partial<Linha>;
      }) => {
        const existente = eventos.find(
          (e) =>
            e.provider === where.provider_externalId.provider &&
            e.externalId === where.provider_externalId.externalId,
        );
        if (existente) return Object.assign(existente, update);
        const linha = { id: `e${eventos.length + 1}`, createdAt: new Date(), ...create } as Linha;
        eventos.push(linha);
        return linha;
      },
      count: async ({
        where,
      }: {
        where: { externalId: { startsWith: string }; resultado: string; createdAt: { gte: Date } };
      }) =>
        eventos.filter(
          (e) =>
            e.externalId.startsWith(where.externalId.startsWith) &&
            e.resultado === where.resultado &&
            e.createdAt >= where.createdAt.gte,
        ).length,
    },
  },
}));

vi.mock("./config", () => ({ configDaRenovacao: async () => config }));

vi.mock("@/server/integrations/chatwoot/ausencias-config", () => ({
  opcoesDeAusencia: async () => ({ ausencias, hoje: "2026-11-16" }),
}));

vi.mock("@/server/integrations/clickup/sistema", () => ({
  abrirClickUp: async () => {
    clickupAberto += 1;
    return {
      cliente: {
        listarTarefasDaLista: async (_lista: string, opcoes: { statuses?: string[] }) => {
          chamadas.push(`clickup:listar:${opcoes.statuses?.join(",")}`);
          return { tasks: listagem };
        },
        tempoNoStatus: async (ids: string[]) => {
          chamadas.push(`clickup:tempo:${ids.join(",")}`);
          return desde;
        },
        comentarTarefa: async (id: string, texto: string) => {
          chamadas.push(`clickup:comentar:${id}:${texto}`);
          return { id: "c1" };
        },
      },
      config: {},
      executar: async () => undefined,
    };
  },
}));

vi.mock("@/server/integrations/chatwoot/credenciais", () => ({
  clienteComTokenDeUsuario: async () =>
    semTokenDoChatwoot
      ? null
      : {
          baseUrl: "https://chatwoot.test",
          contaId: 1,
          buscarContatos: async () => [],
          criarContato: async () => ({ id: 70, sourceId: "src-70" }),
          vincularContatoACaixa: async () => "src-70",
          conversasDoContato: async () => [],
          criarConversa: async (d: { caixaId: number }) => {
            if (falhaAoCriarConversa) throw falhaAoCriarConversa;
            chamadas.push(`chatwoot:conversa-nova:caixa-${d.caixaId}`);
            return 900;
          },
          enviarMensagem: async (id: number, texto: string, opcoes?: { privado?: boolean }) => {
            if (!opcoes?.privado && falhaNoEnvio) throw falhaNoEnvio;
            chamadas.push(`chatwoot:${opcoes?.privado ? "nota" : "mensagem"}:${id}:${texto}`);
            return { id: 1 };
          },
          obterConversa: async () => ({
            status: statusDaConversa,
            assigneeId: donoDaConversa.id,
            assigneeNome: donoDaConversa.nome,
          }),
          listarAtendentes: async () => [
            { id: 44, name: "Felipe Fragoso", email: "felipe@x.test" },
            { id: 45, name: "Ana Lima", email: "ana@x.test" },
          ],
          atribuir: async (id: number, d: { assigneeId: number }) => {
            chamadas.push(`chatwoot:atribuir:${id}:${d.assigneeId}`);
            if (!automacaoDesatribui) {
              donoDaConversa = {
                id: d.assigneeId,
                nome: d.assigneeId === 44 ? "Felipe Fragoso" : "Ana Lima",
              };
            }
          },
          alternarStatus: async (id: number, status: string) => {
            chamadas.push(`chatwoot:status:${id}:${status}`);
            statusDaConversa = status;
          },
        },
}));

const { avisarPorWhatsapp, reiniciarRelogioDoWhatsapp } = await import("./avisar");
const { ENVIOS_POR_RODADA, INTERVALO_ENTRE_ENVIOS_S, TETO_POR_HORA, TEXTO_PADRAO_ONE } = await import(
  "./whatsapp"
);

const CATEGORIAS = [
  { id: "cat-one", name: "ONE", orderindex: 0 },
  { id: "cat-end", name: "Serviços de endereço", orderindex: 1 },
];

function tarefa(
  id: string,
  extra: {
    categoria?: string;
    celular?: unknown;
    responsavel?: string | null;
    nome?: string;
    status?: string;
  } = {},
) {
  const campos: Array<Record<string, unknown>> = [
    {
      id: CAMPO_CATEGORIA,
      name: "CATEGORIA DE SERVIÇO",
      type: "drop_down",
      value: extra.categoria ?? "cat-one",
      type_config: { options: CATEGORIAS },
    },
    {
      id: CAMPO_CELULAR,
      name: "CELULAR",
      type: "phone",
      value: extra.celular === undefined ? "+55 84 99876 5432" : extra.celular,
    },
  ];
  if (extra.responsavel !== null) {
    campos.push({
      id: "campo-responsavel",
      name: "RESPONSÁVEL",
      type: "short_text",
      value: extra.responsavel ?? "Maria Souza",
    });
  }
  return {
    id,
    name: extra.nome ?? `(${id}) LOJA`,
    url: `https://app.clickup.com/t/${id}`,
    status: { status: extra.status ?? "notificação renovação" },
    custom_fields: campos,
  };
}

function com(lista: Array<ReturnType<typeof tarefa>>, entrou = ENTROU) {
  listagem = lista;
  desde = Object.fromEntries(
    lista.map((t) => [t.id, { status: "notificação renovação", desde: entrou }]),
  );
}

const rodar = (agora = AGORA) =>
  avisarPorWhatsapp(
    {
      esperar: true,
      forcar: true,
      dormir: async (ms) => {
        esperas.push(ms);
      },
    },
    agora,
  );

const mensagensAoCliente = () => chamadas.filter((c) => c.startsWith("chatwoot:mensagem"));
const comentarios = () => chamadas.filter((c) => c.startsWith("clickup:comentar"));
const reserva = (id: string, ms = ENTROU) => eventos.find((e) => e.externalId === `whatsapp:${id}:${ms}`);

beforeEach(() => {
  reiniciarRelogioDoWhatsapp();
  eventos = [];
  config = { avisarPorWhatsapp: "ligado", whatsappAtribuirA: "Felipe", whatsappTexto: null };
  chamadas = [];
  clickupAberto = 0;
  semTokenDoChatwoot = false;
  donoDaConversa = { id: null, nome: null };
  statusDaConversa = "open";
  automacaoDesatribui = false;
  falhaNoEnvio = null;
  falhaAoCriarConversa = null;
  esperas = [];
  ausencias = [];
  com([tarefa("t1")]);
});

describe("WhatsApp da renovação ao cliente ONE: o caminho que funciona", () => {
  it("manda a mensagem, atribui ao Felipe, anota e comenta — nessa ordem", async () => {
    const r = await rodar();

    expect(r).toMatchObject({ acao: "conferido", modo: "ligado", noStatus: 1, clientesOne: 1 });
    expect(r.enviadas).toEqual(["(t1) LOJA"]);

    const passos = chamadas.map((c) => c.split(":").slice(0, 2).join(":"));
    expect(passos).toEqual([
      "clickup:listar",
      "clickup:tempo",
      "chatwoot:conversa-nova",
      "chatwoot:mensagem",
      "chatwoot:atribuir",
      "chatwoot:nota",
      "clickup:comentar",
    ]);
    expect(chamadas).toContain("clickup:listar:notificação renovação");
    expect(chamadas).toContain("chatwoot:conversa-nova:caixa-31");
    expect(chamadas).toContain("chatwoot:atribuir:900:44");
    expect(reserva("t1")?.resultado).toBe("enviado");
  });

  it("o texto é o padrão do n8n com o nome do RESPONSÁVEL", async () => {
    await rodar();
    const texto = mensagensAoCliente()[0].replace("chatwoot:mensagem:900:", "");
    expect(texto).toBe(TEXTO_PADRAO_ONE.replace("{responsavel}", "Maria Souza"));
    expect(texto.startsWith("Prezado(a) Maria Souza,")).toBe(true);
  });

  it("texto editado na tela vale no lugar do padrão", async () => {
    config.whatsappTexto = "Olá {responsavel}, o reajuste do seu contrato segue o índice combinado.";
    await rodar();
    expect(mensagensAoCliente()[0]).toContain(
      "Olá Maria Souza, o reajuste do seu contrato segue o índice combinado.",
    );
  });

  it("sem responsável cadastrado, sai 'Prezado(a),' sem o marcador", async () => {
    com([tarefa("t1", { responsavel: null })]);
    await rodar();
    const texto = mensagensAoCliente()[0];
    expect(texto).toContain("Prezado(a),\n");
    expect(texto).not.toContain("{responsavel}");
  });

  it("o comentário na tarefa traz o link da conversa e com quem ficou", async () => {
    await rodar();
    const c = comentarios()[0];
    expect(c).toContain("WhatsApp de renovação enviado");
    expect(c).toContain("https://chatwoot.test/app/accounts/1/conversations/900");
    expect(c).toContain("atribuída a Felipe Fragoso");
  });

  it("a nota interna diz de onde veio a mensagem", async () => {
    await rodar();
    const nota = chamadas.find((c) => c.startsWith("chatwoot:nota"));
    expect(nota).toContain("notificação renovação");
    expect(nota).toContain("https://app.clickup.com/t/t1");
  });

  it("o desfecho do dia fica gravado para a tela e o MCP", async () => {
    await rodar();
    const resumo = eventos.find((e) => e.externalId === "mensagens:2026-11-16");
    expect(resumo?.resultado).toBe("enviado");
    expect(resumo?.detalhe).toContain("(t1) LOJA");
    // Sem telefone em lugar nenhum do rastro.
    expect(JSON.stringify(eventos)).not.toContain("99876");
  });

  it("⚠ o resumo SOMA as rodadas do dia: a que não acha nada não apaga a que mandou", async () => {
    await rodar();
    com([]);
    await rodar();
    const resumo = eventos.find((e) => e.externalId === "mensagens:2026-11-16");
    expect(resumo?.resultado).toBe("enviado");
    expect(resumo?.detalhe).toContain("(t1) LOJA");
  });
});

describe("WhatsApp da renovação: quando NADA sai", () => {
  it("⚠ desligada, não abre nem o ClickUp", async () => {
    config.avisarPorWhatsapp = "desligado";
    const r = await rodar();
    expect(r.acao).toBe("desligada");
    expect(clickupAberto).toBe(0);
    expect(chamadas).toEqual([]);
  });

  it("⚠ só a categoria ONE: endereço e sala privativa não recebem, e nem entram na leitura do tempo", async () => {
    com([tarefa("end", { categoria: "cat-end" })]);
    const r = await rodar();
    expect(r.clientesOne).toBe(0);
    expect(mensagensAoCliente()).toEqual([]);
    expect(chamadas.some((c) => c.startsWith("clickup:tempo"))).toBe(false);
  });

  it("⚠ a mensagem é do momento da passagem: quem está há mais de 4 dias no status não recebe", async () => {
    com([tarefa("t1")], AGORA.getTime() - 5 * 24 * 3_600_000);
    const r = await rodar();
    expect(r.foraDaJanela).toBe(1);
    expect(r.pendentes).toEqual([]); // não é pendência, é o caso normal
    expect(mensagensAoCliente()).toEqual([]);
  });

  it("⚠ o tempo lido tem de ser do status de AGORA: se a leitura diz outro, nada sai e vira pendência", async () => {
    desde = { t1: { status: "renovação", desde: ENTROU } };
    const r = await rodar();
    expect(mensagensAoCliente()).toEqual([]);
    expect(r.pendentes?.[0]).toContain("desde quando");
  });

  it("⚠ a MESMA entrada no status nunca recebe duas mensagens", async () => {
    await rodar();
    chamadas = [];
    const r = await rodar();
    expect(mensagensAoCliente()).toEqual([]);
    expect(comentarios()).toEqual([]);
    expect(r.jaEnviadas).toBe(1);
  });

  it("voltar para renovação e entrar de novo em notificação é OUTRA entrada e recebe de novo", async () => {
    await rodar();
    com([tarefa("t1")], ENTROU + 24 * 3_600_000);
    chamadas = [];
    await rodar();
    expect(mensagensAoCliente()).toHaveLength(1);
    expect(reserva("t1", ENTROU + 24 * 3_600_000)?.resultado).toBe("enviado");
  });

  it("sem CELULAR: não manda, comenta UMA vez e fica como pendência", async () => {
    com([tarefa("t1", { celular: null })]);
    const r = await rodar();
    expect(mensagensAoCliente()).toEqual([]);
    expect(comentarios()).toHaveLength(1);
    expect(comentarios()[0]).toContain("CELULAR");
    expect(r.pendentes?.[0]).toContain("CELULAR");

    chamadas = [];
    await rodar();
    expect(comentarios()).toEqual([]);
  });

  it("sem o token de Integrações → Chatwoot, não há como mandar: nada é reservado nem comentado", async () => {
    semTokenDoChatwoot = true;
    const r = await rodar();
    expect(r.acao).toBe("sem chatwoot");
    expect(eventos.filter((e) => e.externalId.startsWith("whatsapp:"))).toEqual([]);
    expect(comentarios()).toEqual([]);
  });

  it("fora do horário comercial não roda, e antes de 30 minutos é cedo", async () => {
    const domingo = await avisarPorWhatsapp({ esperar: true }, new Date("2026-11-22T13:00:00Z"));
    expect(domingo.acao).toBe("fora do horário");
    expect(clickupAberto).toBe(0);

    await rodar();
    const cedo = await avisarPorWhatsapp(
      { esperar: true },
      new Date(AGORA.getTime() + 10 * 60_000),
    );
    expect(cedo.acao).toBe("cedo");
  });
});

describe("WhatsApp da renovação: o modo sombra", () => {
  beforeEach(() => {
    config.avisarPorWhatsapp = "sombra";
  });

  it("⚠ registra para quem iria e NÃO toca no Chatwoot nem comenta na tarefa", async () => {
    const r = await rodar();
    expect(r.modo).toBe("sombra");
    expect(r.planejadas).toEqual(["(t1) LOJA"]);
    expect(chamadas.some((c) => c.startsWith("chatwoot:"))).toBe(false);
    expect(comentarios()).toEqual([]);

    const ensaio = eventos.find((e) => e.externalId === `whatsapp-sombra:t1:${ENTROU}`);
    expect(ensaio?.resultado).toBe("ensaio");
    expect(ensaio?.detalhe).toContain("…5432");
    expect(JSON.stringify(eventos)).not.toContain("99876");
    expect(eventos.find((e) => e.externalId === "mensagens:2026-11-16")?.resultado).toBe("ensaio");
  });

  it("o mesmo ensaio não se repete a cada rodada", async () => {
    await rodar();
    const r = await rodar();
    expect(r.planejadas).toEqual([]);
    expect(eventos.filter((e) => e.externalId.startsWith("whatsapp-sombra:"))).toHaveLength(1);
  });

  it("⚠ o ensaio NÃO bloqueia o envio quando a chave vai para ligado", async () => {
    await rodar();
    config.avisarPorWhatsapp = "ligado";
    await rodar();
    expect(mensagensAoCliente()).toHaveLength(1);
  });

  it("sem CELULAR na sombra: aparece como pendência, sem comentar na tarefa", async () => {
    com([tarefa("t1", { celular: null })]);
    const r = await rodar();
    expect(r.pendentes?.[0]).toContain("CELULAR");
    expect(comentarios()).toEqual([]);
  });
});

describe("WhatsApp da renovação: recusa libera, incerto segura", () => {
  it("⚠ o Chatwoot recusa o envio (422): nada saiu, comenta uma vez, e não tenta de novo com o mesmo número", async () => {
    falhaNoEnvio = new ChatwootApiError(422, "phone number invalid");
    const r = await rodar();
    expect(r.falhas).toEqual(["(t1) LOJA"]);
    expect(reserva("t1")).toBeUndefined(); // a reserva se desfez
    expect(comentarios()).toHaveLength(1);
    expect(comentarios()[0]).toContain("recusou");

    chamadas = [];
    falhaNoEnvio = null;
    const r2 = await rodar();
    expect(mensagensAoCliente()).toEqual([]); // mesmo número: não insiste
    expect(r2.enviadas).toEqual([]);
  });

  it("corrigido o CELULAR depois da recusa, a tarefa volta a ser tentada", async () => {
    falhaNoEnvio = new ChatwootApiError(422, "phone number invalid");
    await rodar();

    falhaNoEnvio = null;
    com([tarefa("t1", { celular: "+55 84 91111 2222" })]);
    chamadas = [];
    const r = await rodar();
    expect(r.enviadas).toEqual(["(t1) LOJA"]);
    expect(mensagensAoCliente()).toHaveLength(1);
  });

  it("⚠ falha de rede/5xx NO ENVIO pode ter saído: fica incerto, comenta e NÃO reenvia", async () => {
    falhaNoEnvio = new ChatwootApiError(502, "bad gateway");
    const r = await rodar();
    expect(r.incertas).toEqual(["(t1) LOJA"]);
    expect(reserva("t1")?.resultado).toBe("incerto");
    expect(comentarios()).toHaveLength(1);
    expect(comentarios()[0]).toContain("PODE ter chegado");
    expect(eventos.find((e) => e.externalId === "mensagens:2026-11-16")?.resultado).toBe("incerto");

    chamadas = [];
    falhaNoEnvio = null;
    const r2 = await rodar();
    expect(mensagensAoCliente()).toEqual([]);
    expect(r2.jaEnviadas).toBe(1);
  });

  it("falha ANTES do envio (abrir a conversa): nada saiu, a reserva se desfaz e a rodada seguinte tenta", async () => {
    falhaAoCriarConversa = new ChatwootApiError(503, "indisponível");
    const r = await rodar();
    expect(r.falhas).toEqual(["(t1) LOJA"]);
    expect(reserva("t1")).toBeUndefined();
    expect(comentarios()).toEqual([]); // 5xx passageiro não polui a tarefa

    falhaAoCriarConversa = null;
    const r2 = await rodar();
    expect(r2.enviadas).toEqual(["(t1) LOJA"]);
  });

  it("reserva abandonada (processo que caiu no meio) vira incerta, com comentário, e não reenvia", async () => {
    eventos.push({
      id: "velha",
      provider: "RENOVACAO",
      externalId: `whatsapp:t1:${ENTROU}`,
      eventType: "whatsapp",
      payload: {},
      resultado: "reservado",
      detalhe: null,
      createdAt: new Date(AGORA.getTime() - 60 * 60_000),
    });
    const r = await rodar();
    expect(r.incertas).toEqual(["(t1) LOJA"]);
    expect(reserva("t1")?.resultado).toBe("incerto");
    expect(mensagensAoCliente()).toEqual([]);
    expect(comentarios()[0]).toContain("PODE ter chegado");
  });

  it("reserva RECENTE de outro processo não é tocada", async () => {
    eventos.push({
      id: "nova",
      provider: "RENOVACAO",
      externalId: `whatsapp:t1:${ENTROU}`,
      eventType: "whatsapp",
      payload: {},
      resultado: "reservado",
      detalhe: null,
      createdAt: new Date(AGORA.getTime() - 60_000),
    });
    await rodar();
    expect(mensagensAoCliente()).toEqual([]);
    expect(comentarios()).toEqual([]);
    expect(reserva("t1")?.resultado).toBe("reservado");
  });
});

describe("WhatsApp da renovação: a conversa", () => {
  it("⚠ nunca tira a conversa de quem já está com ela", async () => {
    donoDaConversa = { id: 45, nome: "Ana Lima" };
    await rodar();
    expect(chamadas.some((c) => c.startsWith("chatwoot:atribuir"))).toBe(false);
    expect(comentarios()[0]).toContain("já estava com Ana Lima e continua com ela");
  });

  it("⚠ a conversa RESOLVIDA que a caixa 31 devolve é reaberta ANTES de atribuir", async () => {
    statusDaConversa = "resolved";
    await rodar();
    const abrir = chamadas.indexOf("chatwoot:status:900:open");
    const atribuir = chamadas.indexOf("chatwoot:atribuir:900:44");
    expect(abrir).toBeGreaterThan(-1);
    expect(atribuir).toBeGreaterThan(abrir);
  });

  it("a mensagem já saiu mesmo se uma automação desfizer a atribuição, e o comentário diz a verdade", async () => {
    automacaoDesatribui = true;
    const r = await rodar();
    expect(r.enviadas).toEqual(["(t1) LOJA"]);
    const c = comentarios()[0];
    expect(c).not.toContain("Conversa atribuída a");
    expect(c).toContain("provavelmente uma automação do Chatwoot desfez");
  });

  it("com o Felipe ausente, a conversa vai para o substituto", async () => {
    ausencias = [{ nome: "Felipe", substituto: "Ana", ate: "2026-11-30" }];
    await rodar();
    expect(chamadas).toContain("chatwoot:atribuir:900:45");
    expect(comentarios()[0]).toContain("atribuída a Ana Lima");
  });

  it("pessoa que não existe no Chatwoot: a mensagem sai e o comentário avisa", async () => {
    config.whatsappAtribuirA = "Fulano Inexistente";
    const r = await rodar();
    expect(r.enviadas).toEqual(["(t1) LOJA"]);
    expect(comentarios()[0]).toContain('não achei "Fulano Inexistente"');
  });
});

describe("WhatsApp da renovação: os freios", () => {
  it(`⚠ no máximo ${ENVIOS_POR_RODADA} por rodada, espaçados de ${INTERVALO_ENTRE_ENVIOS_S} s`, async () => {
    com(Array.from({ length: ENVIOS_POR_RODADA + 3 }, (_, i) => tarefa(`t${i}`)));
    const r = await rodar();
    expect(r.enviadas).toHaveLength(ENVIOS_POR_RODADA);
    expect(mensagensAoCliente()).toHaveLength(ENVIOS_POR_RODADA);
    // O primeiro não espera; os outros esperam o intervalo inteiro.
    expect(esperas.filter((ms) => ms === INTERVALO_ENTRE_ENVIOS_S * 1000)).toHaveLength(
      ENVIOS_POR_RODADA - 1,
    );
  });

  it("⚠ as que esperam há mais tempo vão primeiro", async () => {
    listagem = [tarefa("nova"), tarefa("velha")];
    desde = {
      nova: { status: "notificação renovação", desde: ENTROU + 3_600_000 },
      velha: { status: "notificação renovação", desde: ENTROU },
    };
    await rodar();
    expect(mensagensAoCliente()).toHaveLength(2);
    const ordem = eventos.filter((e) => e.externalId.startsWith("whatsapp:")).map((e) => e.externalId);
    expect(ordem[0]).toContain("velha");
    expect(ordem[1]).toContain("nova");
  });

  it(`⚠ passou de ${TETO_POR_HORA} envios na última hora: a rodada para`, async () => {
    for (let i = 0; i < TETO_POR_HORA; i++) {
      eventos.push({
        id: `x${i}`,
        provider: "RENOVACAO",
        externalId: `whatsapp:antigas${i}:1`,
        eventType: "whatsapp",
        payload: {},
        resultado: "enviado",
        detalhe: null,
        createdAt: new Date(),
      });
    }
    const r = await rodar();
    expect(r.paradaPeloTeto).toBe(true);
    expect(mensagensAoCliente()).toEqual([]);
    expect(reserva("t1")).toBeUndefined();
  });

  it("o ensaio da sombra não conta no teto por hora", async () => {
    for (let i = 0; i < TETO_POR_HORA; i++) {
      eventos.push({
        id: `s${i}`,
        provider: "RENOVACAO",
        externalId: `whatsapp-sombra:antigas${i}:1`,
        eventType: "whatsapp-sombra",
        payload: {},
        resultado: "enviado",
        detalhe: null,
        createdAt: new Date(),
      });
    }
    const r = await rodar();
    expect(r.paradaPeloTeto).toBeUndefined();
    expect(mensagensAoCliente()).toHaveLength(1);
  });
});
