import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationProvider, RunSource } from "@/generated/prisma/enums";
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
  // Origem sem cliente do outro lado: estes testes travam a MECÂNICA de cada
  // tool. A prova de identidade de quem conversa tem bloco próprio, no fim.
  source: RunSource.TRIGGER,
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

  /** A tool confere o conflito antes de gravar: toda reserva passa por aqui. */
  const ehAAgenda = (c: Chamada) => c.url.pathname.endsWith("/room/bookings");
  const agendaCom = (...itens: unknown[]) => ({
    corpo: { data: itens, pagination: { hasNext: false } },
  });

  /** A pessoa vinculada ao cliente: o Conexa exige uma na reserva. */
  const ehAsPessoas = (c: Chamada) => c.url.pathname.endsWith("/persons");
  const PESSOA = { personId: 777, name: "Pessoa Exemplo", isActive: true };
  const pessoasCom = (...itens: unknown[]) => ({
    corpo: { data: itens, pagination: { hasNext: false } },
  });
  /** O cliente de sempre: uma pessoa só, e o resto como cada teste disser. */
  const comUmaPessoa =
    (fn: (c: Chamada) => { status?: number; corpo: unknown }) => (c: Chamada) =>
      ehAsPessoas(c) ? pessoasCom(PESSOA) : fn(c);

  it("devolve a sala e o horário que o Conexa gravou", async () => {
    responder(comUmaPessoa((c) =>
      // A reserva das 13h às 16h ENCOSTA no pedido das 16h às 17h, e encostar
      // não é sobrepor: tem de deixar gravar.
      ehAAgenda(c)
        ? agendaCom(reserva(28399))
        : c.metodo === "POST"
          ? { corpo: { id: 28400 } }
          : {
              corpo: {
                ...reserva(28400),
                status: "notBilled",
                startTime: "2026-09-15T16:00:00-03:00",
                finalTime: "2026-09-15T17:00:00-03:00",
              },
            },
    ));

    const r = await criar();

    expect(r.criada).toBe(true);
    expect(r.reserva).toMatchObject({
      id: 28400,
      sala: "[SEAWAY] - SALA DE REUNIÃO 03 - 6 Pessoas",
      inicio: "2026-09-15T16:00:00-03:00",
    });
    expect(chamadas.map((c) => `${c.metodo} ${c.url.pathname}`)).toEqual([
      "GET /index.php/api/v2/room/bookings",
      "GET /index.php/api/v2/persons",
      "POST /index.php/api/v2/room/booking",
      "GET /index.php/api/v2/room/booking/28400",
    ]);
    // O corpo usa yyyy-MM-dd e HH:mm — o formato do CORPO, não o do filtro.
    // `chamadas[0]` é a leitura da agenda, `[1]` a das pessoas; o POST é o terceiro.
    expect(chamadas[2].corpo).toMatchObject({
      customerId: 975,
      roomId: 2107,
      date: "2026-09-15",
      startTime: "16:00",
      finalTime: "17:00",
      personId: 777,
    });
  });

  it("falha do servidor não é 'não reservou': manda conferir antes de repetir", async () => {
    // ⚠ Um 5xx pode ter chegado depois de gravar. Relançar faria o modelo
    // corrigir e chamar de novo — a mesma sala reservada duas vezes.
    responder(comUmaPessoa((c) =>
      ehAAgenda(c) ? agendaCom() : { status: 502, corpo: { message: "Bad Gateway" } },
    ));

    const r = await criar();

    expect(r.resultado).toBe("indeterminado");
    expect(String(r.comoSeguir)).toContain("NÃO repita");
    expect(r).not.toHaveProperty("criada");
  });

  it("recusa do Conexa (4xx) continua sendo erro: nada foi gravado", async () => {
    responder(comUmaPessoa((c) =>
      ehAAgenda(c) ? agendaCom() : { status: 422, corpo: { message: "Room unavailable" } },
    ));

    await expect(criar()).rejects.toBeInstanceOf(ConexaApiError);
  });

  it("criada, mas sem conseguir ler de volta: não afirma sala nem horário", async () => {
    responder(comUmaPessoa((c) =>
      ehAAgenda(c)
        ? agendaCom()
        : c.metodo === "POST"
          ? { corpo: { id: 28400 } }
          : { status: 500, corpo: {} },
    ));

    const r = await criar();

    expect(r.criada).toBe(true);
    expect(r.reservaId).toBe(28400);
    expect(r).not.toHaveProperty("reserva");
    expect(String(r.aviso)).toContain("conexa_ver_reserva");
  });

  // ⚠ A trava de conflito. Até 16/09/2026 o único freio era a instrução de
  // consultar a agenda antes — e o modelo pode pular instrução.
  it("recusa quando o horário pedido está ocupado, e NÃO chama o POST", async () => {
    responder(comUmaPessoa((c) =>
      ehAAgenda(c)
        ? agendaCom({
            ...reserva(28100),
            startTime: "2026-09-15T15:30:00-03:00",
            finalTime: "2026-09-15T16:30:00-03:00",
          })
        : { corpo: { id: 28400 } },
    ));

    const r = await criar();

    expect(r.criada).toBe(false);
    expect(r.ocupado).toEqual([
      { inicio: "2026-09-15T15:30:00-03:00", fim: "2026-09-15T16:30:00-03:00" },
    ]);
    expect(String(r.comoSeguir)).toContain("NÃO tente reservar de novo");
    expect(chamadas.map((c) => c.metodo)).toEqual(["GET"]);
  });

  it("reserva cancelada no mesmo horário não impede", async () => {
    responder(comUmaPessoa((c) =>
      ehAAgenda(c)
        ? agendaCom({
            ...reserva(28100),
            status: "cancelled",
            startTime: "2026-09-15T16:00:00-03:00",
            finalTime: "2026-09-15T17:00:00-03:00",
          })
        : c.metodo === "POST"
          ? { corpo: { id: 28400 } }
          : { corpo: reserva(28400) },
    ));

    expect((await criar()).criada).toBe(true);
  });

  it("agenda cortada não autoriza reservar: sem lista inteira não há como provar que está livre", async () => {
    responder(comUmaPessoa((c) =>
      ehAAgenda(c)
        ? { corpo: { data: [reserva(28100)], pagination: { hasNext: true } } }
        : { corpo: { id: 28400 } },
    ));

    const r = await criar();

    expect(r.criada).toBe(false);
    expect(String(r.erro)).toContain("não veio inteira");
    expect(chamadas.every((c) => c.metodo === "GET")).toBe(true);
  });

  it("agenda que não dá para ler recusa, em vez de gravar às cegas", async () => {
    responder(comUmaPessoa((c) =>
      ehAAgenda(c) ? { status: 500, corpo: {} } : { corpo: { id: 28400 } },
    ));

    const r = await criar();

    expect(r.criada).toBe(false);
    expect(String(r.erro)).toContain("não reservei");
    expect(chamadas.every((c) => c.metodo === "GET")).toBe(true);
  });

  it("fim que não é depois do início para antes de qualquer chamada", async () => {
    responder(() => ({ corpo: {} }));

    const r = (await tool("conexa_criar_reserva").execute(
      { ...pedido, inicio: "17:00", fim: "16:00" },
      ctx(),
    )) as Record<string, unknown>;

    expect(String(r.erro)).toContain("não é depois do início");
    expect(chamadas).toEqual([]);
  });

  // ⚠ A pessoa que vai usar a sala. Em 21/09/2026 a primeira reserva tentada
  // por um agente voltou 400 "Person Id cannot be blank": a documentação não
  // marca o campo como obrigatório, e a ferramenta o deixava de fora.
  describe("a pessoa que vai usar a sala", () => {
    const gravacao = () => chamadas.find((c) => c.metodo === "POST");
    const agendaLivreE = (pessoas: () => { status?: number; corpo: unknown }) =>
      responder((c) =>
        ehAsPessoas(c)
          ? pessoas()
          : ehAAgenda(c)
            ? agendaCom()
            : c.metodo === "POST"
              ? { corpo: { id: 28400 } }
              : { corpo: reserva(28400) },
      );

    it("cliente com uma pessoa só: ela vai na reserva, sem perguntar nada", async () => {
      agendaLivreE(() => pessoasCom(PESSOA));
      expect((await criar()).criada).toBe(true);
      expect(gravacao()?.corpo).toMatchObject({ personId: 777 });
      expect(chamadas.find(ehAsPessoas)?.url.searchParams.get("customerId[]")).toBe("975");
    });

    it("pessoa inativa não conta: a única ativa é a escolhida", async () => {
      agendaLivreE(() => pessoasCom({ personId: 700, name: "Ex-sócio", isActive: false }, PESSOA));
      await criar();
      expect(gravacao()?.corpo).toMatchObject({ personId: 777 });
    });

    it("⚠ mais de uma: não escolhe no palpite, devolve a lista e NÃO grava", async () => {
      agendaLivreE(() => pessoasCom(PESSOA, { personId: 778, name: "Outra Pessoa", isActive: true }));
      const r = await criar();
      expect(r.criada).toBe(false);
      expect(r.pessoas).toEqual([
        { id: 777, nome: "Pessoa Exemplo" },
        { id: 778, nome: "Outra Pessoa" },
      ]);
      expect(String(r.comoSeguir)).toContain("solicitanteId");
      expect(gravacao()).toBeUndefined();
    });

    it("lista que não veio inteira também não vira palpite, mesmo com uma só na página", async () => {
      agendaLivreE(() => ({ corpo: { data: [PESSOA], pagination: { hasNext: true } } }));
      const r = await criar();
      expect(r.criada).toBe(false);
      expect(String(r.aviso)).toContain("só as 1 primeiras");
      expect(gravacao()).toBeUndefined();
    });

    it("nenhuma pessoa: manda a equipe cadastrar, e NÃO grava", async () => {
      agendaLivreE(() => pessoasCom());
      const r = await criar();
      expect(r.criada).toBe(false);
      expect(String(r.comoSeguir)).toContain("cadastrar");
      expect(gravacao()).toBeUndefined();
    });

    it("não conseguir ler as pessoas recusa, em vez de gravar sem ela", async () => {
      agendaLivreE(() => ({ status: 500, corpo: {} }));
      const r = await criar();
      expect(r.criada).toBe(false);
      expect(String(r.erro)).toContain("não reservei");
      expect(gravacao()).toBeUndefined();
    });

    it("pessoa informada pelo agente vai direto, sem consultar a lista", async () => {
      agendaLivreE(() => pessoasCom(PESSOA));
      await tool("conexa_criar_reserva").execute({ ...pedido, solicitanteId: 901 }, ctx());
      expect(chamadas.some(ehAsPessoas)).toBe(false);
      expect(gravacao()?.corpo).toMatchObject({ personId: 901 });
    });
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

// ⚠ Pedido do usuário em 22/09/2026: com o NOME de um cliente cadastrado dava
// para reservar em nome dele. A prova é o CPF ou o CNPJ do cadastro escrito
// pelo CLIENTE na conversa — digitado basta (`identidade.ts`).
describe("prova de identidade de quem conversa", () => {
  const BASE = "/index.php/api/v2";
  const CPF = "792.221.104-04";
  const CNPJ = "00.394.460/0058-87";

  const naConversa = (
    historico: { role: "user" | "assistant"; content: string }[],
    mensagem = "pode reservar",
    source: RunSource = RunSource.CHATWOOT,
  ): ToolContext => ({ ...ctx(), source, historico, mensagem, chatwootConversationId: 9329 });

  const clienteDaApi = (extra: Record<string, unknown> = {}) => ({
    customerId: 975,
    name: "César Guilherme Suassuna",
    isActive: true,
    companyId: 3,
    naturalPerson: { cpf: CPF },
    emailsMessage: ["cesar@exemplo.com"],
    phones: ["8499990000"],
    ...extra,
  });

  /** Responde como o Conexa, pela rota. */
  const conexa = (opcoes: { cliente?: Record<string, unknown>; pessoas?: unknown[] } = {}) =>
    responder(({ url, metodo }) => {
      const rota = url.pathname.replace(BASE, "");
      if (rota === "/customer/975") return { corpo: opcoes.cliente ?? clienteDaApi() };
      if (rota === "/persons") {
        return {
          corpo: {
            data: opcoes.pessoas ?? [{ personId: 777, name: "César", isActive: true }],
            pagination: { hasNext: false },
          },
        };
      }
      if (rota === "/room/bookings") return { corpo: { data: [], pagination: { hasNext: false } } };
      if (metodo === "POST" && rota === "/room/booking") return { corpo: { id: 28400 } };
      if (rota === "/room/booking/28400") {
        return { corpo: { ...reserva(28400), saleId: 190001, status: "notBilled", isBilled: false } };
      }
      if (rota === "/charges") return { corpo: { data: [], pagination: { hasNext: false } } };
      return { corpo: {} };
    });

  const rotas = () => chamadas.map((c) => `${c.metodo} ${c.url.pathname.replace(BASE, "")}`);
  const gravou = () => chamadas.some((c) => c.metodo !== "GET");

  const pedido = { clienteId: 975, sala: "2107", data: "2026-09-15", inicio: "16:00", fim: "17:00" };
  const reservar = (c: ToolContext) =>
    tool("conexa_criar_reserva").execute(pedido, c) as Promise<Record<string, unknown>>;

  it("⚠ só o nome do cliente cadastrado NÃO reserva — e a recusa não conta o documento", async () => {
    conexa();

    const r = await reservar(
      naConversa([{ role: "user", content: "Sou o César Guilherme Suassuna, já sou cliente" }]),
    );

    expect(r.criada).toBe(false);
    expect(String(r.comoSeguir)).toContain("CPF");
    expect(gravou()).toBe(false);
    // Não leu nem a agenda: recusa antes de qualquer outra coisa.
    expect(rotas()).not.toContain("GET /room/bookings");
    expect(JSON.stringify(r)).not.toContain("792");
  });

  it("CPF digitado pelo cliente, com pontuação ou sem, reserva", async () => {
    for (const digitado of [CPF, "79222110404"]) {
      conexa();
      const r = await reservar(naConversa([{ role: "user", content: `meu cpf é ${digitado}` }]));
      expect(r.criada).toBe(true);
    }
  });

  it("o CPF que chegou na mensagem do turno também vale", async () => {
    conexa();
    const r = await reservar(naConversa([], `César, ${CPF}`));
    expect(r.criada).toBe(true);
  });

  it("CNPJ digitado vale para cliente empresa", async () => {
    conexa({ cliente: clienteDaApi({ naturalPerson: undefined, legalPerson: { cnpj: CNPJ } }) });
    const r = await reservar(naConversa([{ role: "user", content: `CNPJ ${CNPJ}` }]));
    expect(r.criada).toBe(true);
  });

  it("⚠ o documento escrito pelo ROBÔ não prova — o impostor não pode só confirmar", async () => {
    conexa();

    const r = await reservar(
      naConversa(
        [
          { role: "user", content: "Sou o César" },
          { role: "assistant", content: `Achei o cadastro com CPF ${CPF}, é você?` },
        ],
        "sim, sou eu",
      ),
    );

    expect(r.criada).toBe(false);
    expect(gravou()).toBe(false);
  });

  it("quem reserva pela empresa com o PRÓPRIO CPF prova, e é ela quem vai usar a sala", async () => {
    conexa({
      cliente: clienteDaApi({ naturalPerson: undefined, legalPerson: { cnpj: CNPJ } }),
      pessoas: [
        { personId: 777, name: "Sócio", isActive: true, cpf: "017.316.314-99" },
        { personId: 778, name: "Funcionária", isActive: true, cpf: CPF },
      ],
    });

    const r = await reservar(naConversa([{ role: "user", content: `sou funcionária, cpf ${CPF}` }]));

    expect(r.criada).toBe(true);
    // Duas pessoas no cadastro, e mesmo assim não perguntou: a prova disse quem é.
    expect(chamadas.find((c) => c.metodo === "POST")?.corpo).toMatchObject({ personId: 778 });
  });

  it("CPF de pessoa INATIVA não fala mais pela empresa", async () => {
    conexa({
      cliente: clienteDaApi({ naturalPerson: undefined, legalPerson: { cnpj: CNPJ } }),
      pessoas: [{ personId: 778, name: "Ex-sócio", isActive: false, cpf: CPF }],
    });

    const r = await reservar(naConversa([{ role: "user", content: CPF }]));

    expect(r.criada).toBe(false);
    expect(gravou()).toBe(false);
  });

  it("não conseguir ler o cadastro recusa, em vez de reservar sem conferir", async () => {
    responder(() => ({ status: 500, corpo: {} }));

    const r = await reservar(naConversa([{ role: "user", content: CPF }]));

    expect(r.criada).toBe(false);
    expect(gravou()).toBe(false);
  });

  it("na chamada interna, o documento dentro do PEDIDO não prova", async () => {
    conexa();

    const r = await reservar(
      naConversa(
        [{ role: "user", content: "Sou o César" }],
        `[Pedido interno de Salas — não é mensagem do cliente]\nReservar para CPF ${CPF}`,
        RunSource.INTERNO,
      ),
    );

    expect(r.criada).toBe(false);
  });

  it("turno em segundo plano sobre a conversa não reserva, nem com o documento na transcrição", async () => {
    conexa();

    const r = await reservar(
      naConversa([], `[transcrição do atendimento]\n${CPF}`, RunSource.CONVERSA_PARADA),
    );

    expect(r.criada).toBe(false);
    expect(chamadas).toEqual([]);
  });

  it("na mesa, quem pede é a equipe: reserva sem ler o cadastro", async () => {
    conexa();

    const r = await reservar({ ...ctx(), source: RunSource.MESA, mensagem: "reservar para o César" });

    expect(r.criada).toBe(true);
    expect(rotas()).not.toContain("GET /customer/975");
  });

  it("faturar sem a prova não lê cobrança nem cria", async () => {
    conexa();

    const r = (await tool("conexa_faturar_reserva").execute(
      { reservaId: 28400 },
      naConversa([{ role: "user", content: "Sou o César" }]),
    )) as Record<string, unknown>;

    expect(r.faturada).toBe(false);
    expect(rotas()).not.toContain("GET /charges");
    expect(gravou()).toBe(false);
  });

  it("faturar com a prova segue o caminho de sempre", async () => {
    conexa();

    await tool("conexa_faturar_reserva").execute(
      { reservaId: 28400 },
      naConversa([{ role: "user", content: CPF }]),
    );

    expect(rotas()).toContain("POST /charge");
  });

  it("cancelar e alterar a reserva também exigem a prova", async () => {
    conexa();
    const semProva = naConversa([{ role: "user", content: "Sou o César" }]);

    const c = (await tool("conexa_cancelar_reserva").execute(
      { reservaId: 28400 },
      semProva,
    )) as Record<string, unknown>;
    const a = (await tool("conexa_alterar_reserva").execute(
      { reservaId: 28400, inicio: "18:00" },
      semProva,
    )) as Record<string, unknown>;

    expect(c.cancelada).toBe(false);
    expect(a.alterada).toBe(false);
    expect(gravou()).toBe(false);
  });

  it("⚠ ver cliente achado só pelo nome esconde documento e contato", async () => {
    conexa();

    const r = (await tool("conexa_ver_cliente").execute(
      { clienteId: 975 },
      naConversa([{ role: "user", content: "Sou o César Guilherme Suassuna" }]),
    )) as Record<string, unknown>;

    expect(r).toMatchObject({ id: 975, nome: "César Guilherme Suassuna" });
    expect(r).not.toHaveProperty("cpf");
    expect(r).not.toHaveProperty("emails");
    expect(r).not.toHaveProperty("telefones");
    expect(JSON.stringify(r)).not.toContain("792");
  });

  describe("cobranças (Financeiro)", () => {
    /** Cobrança pendente do cliente 975, e a venda dela. */
    const cobrancas = () =>
      responder(({ url, metodo }) => {
        const rota = url.pathname.replace(BASE, "");
        if (rota === "/customer/975") return { corpo: clienteDaApi() };
        if (rota === "/persons") return { corpo: { data: [], pagination: { hasNext: false } } };
        if (rota === "/charges") {
          return {
            corpo: {
              data: [{ chargeId: 7001, customerId: 975, status: "unpaid", billetUrl: "https://b/1" }],
              pagination: { hasNext: false },
            },
          };
        }
        if (rota === "/charge/7001") {
          return { corpo: { chargeId: 7001, customerId: 975, status: "unpaid", billetUrl: "https://b/1" } };
        }
        if (rota === "/charge/pix/7001") return { corpo: { copyPasteCode: "000201pix" } };
        if (rota === "/sale/190001") return { corpo: { saleId: 190001, customerId: 975 } };
        if (metodo === "POST" && rota === "/charge") return { corpo: { id: 7002 } };
        return { status: 404, corpo: {} };
      });
    const semProva = () => naConversa([{ role: "user", content: "Sou o César, quero a 2ª via" }]);
    const comProva = () => naConversa([{ role: "user", content: `2ª via, cpf ${CPF}` }]);

    it("⚠ listar cobranças de quem só disse o nome: recusa sem consultar", async () => {
      cobrancas();
      const r = (await tool("conexa_listar_cobrancas").execute({ clienteId: 975 }, semProva())) as Record<string, unknown>;
      expect(r).not.toHaveProperty("cobrancas");
      expect(String(r.comoSeguir)).toContain("CPF");
      expect(rotas()).not.toContain("GET /charges");
    });

    it("listar cobranças depois do documento digitado segue como sempre", async () => {
      cobrancas();
      const r = (await tool("conexa_listar_cobrancas").execute({ clienteId: 975 }, comProva())) as Record<string, unknown>;
      expect(r.total).toBe(1);
    });

    it("ver a cobrança sem a prova não entrega boleto nem link", async () => {
      cobrancas();
      const r = await tool("conexa_ver_cobranca").execute({ cobrancaId: 7001 }, semProva());
      expect(JSON.stringify(r)).not.toContain("https://b/1");
    });

    it("Pix sem a prova não chega a ser pedido ao Conexa", async () => {
      cobrancas();
      const r = (await tool("conexa_pix_da_cobranca").execute({ cobrancaId: 7001 }, semProva())) as Record<string, unknown>;
      expect(r).not.toHaveProperty("copiaECola");
      expect(rotas()).not.toContain("GET /charge/pix/7001");
    });

    it("Pix com a prova sai", async () => {
      cobrancas();
      const r = await tool("conexa_pix_da_cobranca").execute({ cobrancaId: 7001 }, comProva());
      expect(r).toEqual({ copiaECola: "000201pix" });
    });

    it("criar cobrança das vendas de um cliente sem a prova não grava", async () => {
      cobrancas();
      const r = (await tool("conexa_criar_cobranca").execute({ vendaIds: [190001] }, semProva())) as Record<string, unknown>;
      expect(r.criada).toBe(false);
      expect(gravou()).toBe(false);
    });

    it("gatilho (a cobrança do legba) segue sem ler o cadastro", async () => {
      cobrancas();
      const r = (await tool("conexa_listar_cobrancas").execute({ clienteId: 975 }, ctx())) as Record<string, unknown>;
      expect(r.total).toBe(1);
      expect(rotas()).not.toContain("GET /customer/975");
    });
  });

  it("ver cliente depois que ele digitou o documento mostra tudo", async () => {
    conexa();

    const r = await tool("conexa_ver_cliente").execute(
      { clienteId: 975 },
      naConversa([{ role: "user", content: `cpf ${CPF}` }]),
    );

    expect(r).toMatchObject({ cpf: CPF, emails: ["cesar@exemplo.com"] });
  });
});
