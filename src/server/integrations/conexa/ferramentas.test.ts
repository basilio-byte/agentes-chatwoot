import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationProvider } from "@/generated/prisma/enums";
import type { ToolContext } from "../types";
import { ConexaApiError } from "./client";
import { conexaIntegration, TETO_DA_AGENDA } from "./index";

/**
 * As tools de cliente e de reserva, de ponta a ponta até o `fetch`.
 *
 * Os módulos puros (`entrada.ts`, `formatacao.ts`) têm teste de mesa; aqui se
 * trava a LIGAÇÃO — que a tool usa a tradução certa e repassa ao modelo o que a
 * API disse. Foi numa ligação assim que a agenda perdeu o `hasNext`: o cliente
 * HTTP lia o campo, e a tool o jogava fora.
 */

const tool = (nome: string) => {
  const t = conexaIntegration.tools.find((x) => x.name === nome);
  if (!t) throw new Error(`tool ${nome} não existe`);
  return t;
};

type Chamada = { url: URL; metodo: string; corpo: unknown };
let chamadas: Chamada[] = [];

function responder(fn: (c: Chamada) => { status?: number; corpo: unknown }) {
  chamadas = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const chamada: Chamada = {
      url: new URL(String(url)),
      metodo: init.method ?? "GET",
      corpo: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    chamadas.push(chamada);
    const { status = 200, corpo } = fn(chamada);
    return {
      ok: status < 400,
      status,
      json: async () => corpo,
      text: async () => JSON.stringify(corpo),
      headers: new Headers(),
    } as unknown as Response;
  });
}

afterEach(() => vi.unstubAllGlobals());

const ctx = (): ToolContext => ({
  provider: IntegrationProvider.CONEXA,
  // Sem salas cadastradas, como em produção em 14/09/2026.
  config: {
    baseUrl: "https://seahub.conexa.app/index.php/api/v2",
    unidades: [{ nome: "SEAHUB COWORKING", companyId: 3 }],
  },
  credential: "tok_123",
  agentId: "salas-de-reuniao",
});

/** Uma reserva como `GET /room/bookings` devolve. */
const reserva = (id: number) => ({
  bookingId: id,
  place: { id: 2107, name: "[SEAWAY] - SALA DE REUNIÃO 03 - 6 Pessoas" },
  customerId: 975,
  status: "paid",
  startTime: "2026-09-15T13:00:00-03:00",
  finalTime: "2026-09-15T16:00:00-03:00",
});

const pagina = (quantas: number, desde: number, hasNext: boolean) => ({
  data: Array.from({ length: quantas }, (_, i) => reserva(desde + i)),
  pagination: { hasNext },
});

describe("conexa_listar_reservas", () => {
  const listar = (entrada: Record<string, unknown>) =>
    tool("conexa_listar_reservas").execute(entrada, ctx()) as Promise<
      Record<string, unknown> & { total: number; reservas: unknown[] }
    >;

  it("percorre as páginas até o fim, em vez de parar na primeira", async () => {
    // ⚠ Em 14/09/2026 a agenda do dia voltou com exatamente 25 reservas, e o
    // agente ofereceu ao cliente horários "livres" deduzidos dela.
    responder(({ url }) =>
      url.searchParams.get("offset") === "50"
        ? { corpo: pagina(3, 51, false) }
        : { corpo: pagina(50, 1, true) },
    );

    const r = await listar({ de: "2026-09-15", ate: "2026-09-15" });

    expect(r.completa).toBe(true);
    expect(r.total).toBe(53);
    expect(r.reservas).toHaveLength(53);
    expect(chamadas).toHaveLength(2);
    expect(chamadas[1].url.searchParams.get("offset")).toBe("50");
  });

  it("no teto, diz que a lista não veio inteira e proíbe concluir que está livre", async () => {
    responder(() => ({ corpo: pagina(50, 1, true) }));

    const r = await listar({ de: "2026-09-15" });

    expect(r.completa).toBe(false);
    expect(r.total).toBe(TETO_DA_AGENDA);
    expect(String(r.aviso)).toContain("NÃO conclua");
  });

  it("manda o dia no formato que o filtro exige", async () => {
    responder(() => ({ corpo: pagina(0, 1, false) }));

    await listar({ de: "2026-09-15", ate: "2026-09-15" });

    const q = chamadas[0].url.searchParams;
    expect(q.get("bookingDateTimeFrom")).toBe("2026-09-15T00:00:00-03:00");
    expect(q.get("bookingDateTimeTo")).toBe("2026-09-15T23:59:59-03:00");
  });

  it("data em formato errado volta como erro, sem chamar a API", async () => {
    responder(() => ({ corpo: pagina(0, 1, false) }));

    const r = await listar({ de: "15/09/2026" });

    expect(r).toHaveProperty("erro");
    expect(chamadas).toHaveLength(0);
  });

  it("sala pelo nome, sem cadastro: NÃO diz que a sala não existe", async () => {
    // ⚠ A mensagem antiga fez o agente confessar ao cliente que tinha inventado
    // a Sala Ariano — que estava na agenda que ele acabara de ler.
    responder(() => ({ corpo: pagina(0, 1, false) }));

    const r = await listar({ sala: "Sala Ariano", de: "2026-09-15" });

    expect(String(r.erro)).toContain("NÃO quer dizer que a sala não existe");
    expect(String(r.comoResolver)).toContain("salaId");
    expect(chamadas).toHaveLength(0);
  });

  it("sala pelo salaId da agenda filtra pela sala", async () => {
    responder(() => ({ corpo: pagina(1, 1, false) }));

    await listar({ sala: "2107", de: "2026-09-15" });

    expect(chamadas[0].url.searchParams.get("roomId[]")).toBe("2107");
  });

  it("sala sem reserva nenhuma lembra que número errado também volta vazio", async () => {
    // Um "03" tirado do nome da sala vira roomId 3, e a agenda de uma sala que
    // não existe volta vazia — que se leria como livre o dia todo.
    responder(() => ({ corpo: pagina(0, 1, false) }));

    const r = await listar({ sala: "2107", de: "2026-09-15", ate: "2026-09-15" });

    expect(r.total).toBe(0);
    expect(String(r.aviso)).toContain("salaId");
  });
});

describe("conexa_criar_reserva", () => {
  const pedido = {
    clienteId: 975,
    sala: "2107",
    data: "2026-09-15",
    inicio: "16:00",
    fim: "17:00",
  };
  const criar = () =>
    tool("conexa_criar_reserva").execute(pedido, ctx()) as Promise<Record<string, unknown>>;

  it("devolve a sala e o horário que o Conexa gravou", async () => {
    responder(({ metodo }) =>
      metodo === "POST"
        ? { corpo: { id: 28400 } }
        : {
            corpo: {
              ...reserva(28400),
              status: "notBilled",
              startTime: "2026-09-15T16:00:00-03:00",
              finalTime: "2026-09-15T17:00:00-03:00",
            },
          },
    );

    const r = await criar();

    expect(r.criada).toBe(true);
    expect(r.reserva).toMatchObject({
      id: 28400,
      sala: "[SEAWAY] - SALA DE REUNIÃO 03 - 6 Pessoas",
      inicio: "2026-09-15T16:00:00-03:00",
    });
    expect(chamadas.map((c) => `${c.metodo} ${c.url.pathname}`)).toEqual([
      "POST /index.php/api/v2/room/booking",
      "GET /index.php/api/v2/room/booking/28400",
    ]);
    // O corpo usa yyyy-MM-dd e HH:mm — o formato do CORPO, não o do filtro.
    expect(chamadas[0].corpo).toMatchObject({
      customerId: 975,
      roomId: 2107,
      date: "2026-09-15",
      startTime: "16:00",
      finalTime: "17:00",
    });
  });

  it("falha do servidor não é 'não reservou': manda conferir antes de repetir", async () => {
    // ⚠ Um 5xx pode ter chegado depois de gravar. Relançar faria o modelo
    // corrigir e chamar de novo — a mesma sala reservada duas vezes.
    responder(() => ({ status: 502, corpo: { message: "Bad Gateway" } }));

    const r = await criar();

    expect(r.resultado).toBe("indeterminado");
    expect(String(r.comoSeguir)).toContain("NÃO repita");
    expect(r).not.toHaveProperty("criada");
  });

  it("recusa do Conexa (4xx) continua sendo erro: nada foi gravado", async () => {
    responder(() => ({ status: 422, corpo: { message: "Room unavailable" } }));

    await expect(criar()).rejects.toBeInstanceOf(ConexaApiError);
  });

  it("criada, mas sem conseguir ler de volta: não afirma sala nem horário", async () => {
    responder(({ metodo }) =>
      metodo === "POST" ? { corpo: { id: 28400 } } : { status: 500, corpo: {} },
    );

    const r = await criar();

    expect(r.criada).toBe(true);
    expect(r.reservaId).toBe(28400);
    expect(r).not.toHaveProperty("reserva");
    expect(String(r.aviso)).toContain("conexa_ver_reserva");
  });
});

describe("clientes", () => {
  it("criar manda documento e contato onde a documentação pede", async () => {
    responder(() => ({ corpo: { id: 6001 } }));

    const r = await tool("conexa_criar_cliente").execute(
      {
        nome: "Arthur Pereira da Rocha Lopes",
        cpf: "01731631499",
        email: "arthur@exemplo.com",
        telefone: "+558491631300",
      },
      ctx(),
    );

    expect(r).toEqual({ criado: true, clienteId: 6001 });
    expect(chamadas[0].corpo).toEqual({
      companyId: 3,
      name: "Arthur Pereira da Rocha Lopes",
      naturalPerson: { cpf: "017.316.314-99" },
      emailsMessage: ["arthur@exemplo.com"],
      phones: ["8491631300"],
    });
  });

  it("criar: falha do servidor manda procurar antes de cadastrar de novo", async () => {
    responder(() => ({ status: 503, corpo: {} }));

    const r = (await tool("conexa_criar_cliente").execute(
      { nome: "Arthur Lopes", cpf: "01731631499" },
      ctx(),
    )) as Record<string, unknown>;

    expect(r.resultado).toBe("indeterminado");
    expect(String(r.comoSeguir)).toContain("conexa_buscar_cliente");
  });

  it("atualizar lê o cliente e ACRESCENTA o e-mail", async () => {
    responder(({ metodo }) =>
      metodo === "GET"
        ? { corpo: { customerId: 975, emailsMessage: ["financeiro@empresa.com"] } }
        : { corpo: {} },
    );

    await tool("conexa_atualizar_cliente").execute(
      { clienteId: 975, email: "novo@empresa.com" },
      ctx(),
    );

    const patch = chamadas.find((c) => c.metodo === "PATCH");
    expect(patch?.url.pathname).toContain("/customer/975");
    expect(patch?.corpo).toEqual({
      emailsMessage: ["financeiro@empresa.com", "novo@empresa.com"],
    });
  });

  it("ver cliente mostra o documento pelo qual ele foi achado", async () => {
    // ⚠ Em 14/09/2026 o agente achou o cliente pelo CPF e a ficha voltou sem CPF.
    responder(() => ({
      corpo: {
        customerId: 975,
        name: "César Guilherme Suassuna",
        isActive: true,
        companyId: 3,
        naturalPerson: { cpf: "792.221.104-04" },
        emailsMessage: ["cesar@exemplo.com"],
        phones: ["8499990000"],
      },
    }));

    const r = await tool("conexa_ver_cliente").execute({ clienteId: 975 }, ctx());

    expect(r).toMatchObject({
      id: 975,
      cpf: "792.221.104-04",
      emails: ["cesar@exemplo.com"],
      telefones: ["8499990000"],
    });
  });

  it("buscar não espalha contato nem documento de homônimos", async () => {
    responder(() => ({
      corpo: {
        data: [
          {
            customerId: 1,
            name: "Maria",
            emailsMessage: ["m@x.com"],
            phones: ["8499990000"],
            naturalPerson: { cpf: "111.111.111-11" },
          },
        ],
        pagination: { hasNext: false },
      },
    }));

    const r = (await tool("conexa_buscar_cliente").execute({ nome: "Maria" }, ctx())) as {
      clientes: Record<string, unknown>[];
    };

    expect(r.clientes[0]).toEqual({ id: 1, nome: "Maria" });
  });
});

describe("conexa_faturar_reserva", () => {
  const BASE = "/index.php/api/v2";
  const faturar = () =>
    tool("conexa_faturar_reserva").execute({ reservaId: 28400 }, ctx()) as Promise<
      Record<string, unknown>
    >;

  const reservaDaApi = (extra: Record<string, unknown> = {}) => ({
    ...reserva(28400),
    saleId: 190001,
    status: "notBilled",
    isBilled: false,
    canceled: false,
    startTime: "2026-09-21T16:00:00-03:00",
    finalTime: "2026-09-21T17:00:00-03:00",
    ...extra,
  });

  const cobrancaDaApi = {
    chargeId: 7001,
    status: "unpaid",
    amount: 60,
    currentAmount: 60,
    dueDate: "2026-09-21",
    chargeUrl: "https://seahub.conexa.app/fatura/abc",
    billetUrl: "https://seahub.conexa.app/boleto/abc.pdf",
    salesIds: [190001],
  };

  /** Responde como o Conexa, pela rota; `pendentes` é o GET /charges. */
  const conexa = (opcoes: {
    reserva?: Record<string, unknown>;
    pendentes?: unknown[];
    postStatus?: number;
  }) =>
    responder(({ url, metodo }) => {
      if (url.pathname === `${BASE}/room/booking/28400`) {
        return { corpo: reservaDaApi(opcoes.reserva) };
      }
      if (url.pathname === `${BASE}/charges`) {
        return { corpo: { data: opcoes.pendentes ?? [], pagination: { hasNext: false } } };
      }
      if (metodo === "POST" && url.pathname === `${BASE}/charge`) {
        return { status: opcoes.postStatus ?? 200, corpo: { id: 7001 } };
      }
      if (url.pathname === `${BASE}/charge/7001`) return { corpo: cobrancaDaApi };
      return { status: 404, corpo: {} };
    });

  const rotas = () => chamadas.map((c) => `${c.metodo} ${c.url.pathname.replace(BASE, "")}`);

  it("cobra a venda da reserva, vencendo no dia dela, e devolve valor e link", async () => {
    conexa({});

    const r = await faturar();

    expect(r.faturada).toBe(true);
    expect(r.cobranca).toMatchObject({
      valorAtual: 60,
      vencimento: "2026-09-21",
      faturaUrl: "https://seahub.conexa.app/fatura/abc",
    });
    expect(rotas()).toEqual([
      "GET /room/booking/28400",
      "GET /charges",
      "POST /charge",
      "GET /charge/7001",
    ]);
    // Só as pendentes do cliente, e o corpo com a venda e o dia da reserva.
    expect(chamadas[1].url.searchParams.get("customerId[]")).toBe("975");
    expect(chamadas[1].url.searchParams.get("status")).toBe("unpaid");
    expect(chamadas[2].corpo).toEqual({ salesIds: [190001], dueDate: "2026-09-21" });
  });

  it("pacote de horas: não cria cobrança", async () => {
    conexa({ reserva: { status: "deductedFromQuota" } });

    const r = await faturar();

    expect(r.descontadaDoPacoteDeHoras).toBe(true);
    expect(rotas()).toEqual(["GET /room/booking/28400"]);
  });

  it("cancelada: recusa sem tocar em cobrança", async () => {
    conexa({ reserva: { status: "cancelled", canceled: true } });

    const r = await faturar();

    expect(r.faturada).toBe(false);
    expect(r).toHaveProperty("erro");
    expect(rotas()).toEqual(["GET /room/booking/28400"]);
  });

  it("cobrança pendente com a venda já existe: devolve ela e NÃO cria outra", async () => {
    // ⚠ É a trava contra cobrar duas vezes: o modelo repete chamada, e nada
    // garante que a reserva vire "billed" no instante em que a cobrança nasce.
    conexa({ pendentes: [cobrancaDaApi] });

    const r = await faturar();

    expect(r.faturada).toBe(true);
    expect(r.jaExistia).toBe(true);
    expect(rotas()).not.toContain("POST /charge");
  });

  it("já faturada e sem pendente achada: não cobra e manda a equipe mandar o link", async () => {
    conexa({ reserva: { status: "billed", isBilled: true } });

    const r = await faturar();

    expect(r.faturada).toBe(false);
    expect(r.jaFaturada).toBe(true);
    expect(rotas()).not.toContain("POST /charge");
  });

  it("falha do servidor ao cobrar: indeterminado, e proíbe repetir", async () => {
    conexa({ postStatus: 502 });

    const r = await faturar();

    expect(r.resultado).toBe("indeterminado");
    expect(String(r.comoSeguir)).toContain("NÃO repita");
    expect(r).not.toHaveProperty("faturada");
  });

  it("recusa do Conexa ao cobrar (4xx) continua sendo erro", async () => {
    conexa({ postStatus: 422 });

    await expect(faturar()).rejects.toBeInstanceOf(ConexaApiError);
  });
});
