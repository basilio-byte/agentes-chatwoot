import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConexaApiError, ConexaClient } from "./client";
import { conexaConfigSchema, resolverSala, resolverUnidade } from "./config";

/**
 * Testes de contrato: travam método, rota, query e corpo de cada chamada.
 *
 * A API do Conexa não tem ambiente de teste aberto, então é aqui que a forma
 * das requisições fica registrada. Se alguém mexer no cliente e uma rota mudar
 * sem querer, o erro aparece aqui — não num atendimento real às 3h da manhã.
 */

const config = conexaConfigSchema.parse({
  baseUrl: "https://seahub.conexa.app/index.php/api/v2",
  unidades: [
    { nome: "Natal", companyId: 3 },
    { nome: "Recife", companyId: 7 },
  ],
  sellerId: 531,
  salas: [{ nome: "Sala Executiva", roomId: 4140 }],
});

let chamadas: { url: string; init: RequestInit }[];
let resposta: { status: number; corpo: unknown };

beforeEach(() => {
  chamadas = [];
  resposta = { status: 200, corpo: { data: [], pagination: { hasNext: false } } };

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    chamadas.push({ url: String(url), init });
    return {
      ok: resposta.status < 400,
      status: resposta.status,
      json: async () => resposta.corpo,
      text: async () => JSON.stringify(resposta.corpo),
      headers: new Headers(),
    } as unknown as Response;
  });
});

const cliente = () => new ConexaClient(config, "tok_permanente_123");
const ultima = () => chamadas.at(-1)!;
const query = () => new URL(ultima().url).searchParams;
const corpoEnviado = () => JSON.parse(String(ultima().init.body));

describe("autenticação e base", () => {
  it("manda o token permanente como Bearer", async () => {
    await cliente().obterCliente(42);

    const headers = ultima().init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok_permanente_123");
  });

  it("monta a URL a partir da instância configurada", async () => {
    await cliente().obterCliente(42);

    expect(ultima().url).toBe(
      "https://seahub.conexa.app/index.php/api/v2/customer/42",
    );
  });

  it("barra dupla não aparece quando a baseUrl termina em barra", async () => {
    const c = new ConexaClient(
      { ...config, baseUrl: "https://seahub.conexa.app/index.php/api/v2/" },
      "tok",
    );
    await c.obterCliente(1);

    expect(ultima().url).not.toContain("v2//");
  });
});

describe("paginação", () => {
  /**
   * A Conexa descontinua a paginação antiga em 01/08/2026, e cair nela é
   * silencioso: a resposta muda de forma e `data` vem vazio. `limit` tem de ir
   * em toda listagem, sempre.
   */
  it("SEMPRE envia limit — sem ele a API cai no modelo descontinuado", async () => {
    await cliente().buscarClientes({ name: "Maria" });
    expect(query().get("limit")).toBe("50");

    await cliente().listarPlanos({});
    expect(query().get("limit")).toBe("50");

    await cliente().listarReservas({ roomId: 4140 });
    expect(query().get("limit")).toBe("50");

    await cliente().listarCobrancas({ customerId: 9 });
    expect(query().get("limit")).toBe("50");
  });

  it("respeita o limite pedido", async () => {
    await cliente().buscarClientes({ name: "Maria", limit: 5 });
    expect(query().get("limit")).toBe("5");
  });

  it("devolve os itens e se há mais páginas", async () => {
    resposta = {
      status: 200,
      corpo: { data: [{ id: 1 }, { id: 2 }], pagination: { hasNext: true } },
    };

    const pagina = await cliente().buscarClientes({ limit: 2 });

    expect(pagina.itens).toHaveLength(2);
    expect(pagina.temMais).toBe(true);
  });

  it("resposta sem data não quebra", async () => {
    resposta = { status: 200, corpo: {} };

    const pagina = await cliente().listarPlanos({});

    expect(pagina.itens).toEqual([]);
    expect(pagina.temMais).toBe(false);
  });
});

describe("filtros", () => {
  it("array vai num parâmetro só, separado por vírgula", async () => {
    await cliente().buscarClientes({ companyId: 3 });

    expect(query().get("companyId[]")).toBe("3");
  });

  it("filtro vazio não vira parâmetro", async () => {
    await cliente().buscarClientes({ name: "", cpf: undefined, limit: 10 });

    expect(query().has("name")).toBe(false);
    expect(query().has("cpf")).toBe(false);
  });
});

describe("venda: o caminho que fecha o negócio", () => {
  it("contrato carrega o sellerId da configuração", async () => {
    // Com API Token não há usuário logado, e a Conexa exige o vendedor.
    // Deixar isso para o modelo lembrar seria uma venda órfã por esquecimento.
    resposta = { status: 200, corpo: { id: 900 } };

    await cliente().criarContrato({ planId: 12, customerId: 42 });

    expect(ultima().init.method).toBe("POST");
    expect(corpoEnviado()).toMatchObject({ sellerId: 531, planId: 12, customerId: 42 });
  });

  it("quem chamou pode sobrescrever o vendedor", async () => {
    await cliente().criarContrato({ planId: 12, customerId: 42, sellerId: 999 });

    expect(corpoEnviado().sellerId).toBe(999);
  });

  it("sem vendedor configurado, não inventa o campo", async () => {
    const c = new ConexaClient({ ...config, sellerId: undefined }, "tok");
    await c.criarContrato({ planId: 12, customerId: 42 });

    expect(corpoEnviado()).not.toHaveProperty("sellerId");
  });

  it("assinatura vai na rota do contrato e aceita WhatsApp", async () => {
    await cliente().solicitarAssinatura(900, {
      contractTemplateId: 1,
      customerSigners: [
        {
          name: "Maria Silva",
          deliveryMethod: "whatsapp",
          deliveryValue: "5584999998888",
          role: "sign",
        },
      ],
    });

    expect(ultima().url).toContain("/contract/900/signature/request");
    expect(ultima().init.method).toBe("POST");
    expect(corpoEnviado().customerSigners[0].deliveryMethod).toBe("whatsapp");
  });

  it("cobrança aponta para as vendas do cliente", async () => {
    await cliente().criarCobranca({ salesIds: [188087], dueDate: "2026-08-05" });

    expect(ultima().url).toContain("/charge");
    expect(corpoEnviado()).toEqual({ salesIds: [188087], dueDate: "2026-08-05" });
  });

  it("o Pix é lido na hora, nunca guardado", async () => {
    resposta = { status: 200, corpo: { copyPasteCode: "00020126", qrCode: "iVBOR" } };

    const pix = await cliente().obterPix(555);

    expect(ultima().url).toContain("/charge/pix/555");
    expect(pix.copyPasteCode).toBe("00020126");
  });
});

describe("reservas", () => {
  it("criar reserva usa a rota do coworking", async () => {
    await cliente().criarReserva({
      customerId: 450,
      roomId: 4140,
      date: "2026-08-05",
      startTime: "08:00",
      finalTime: "16:00",
    });

    expect(ultima().url).toContain("/room/booking");
    expect(ultima().init.method).toBe("POST");
  });

  it("cancelar tem rota própria e é PATCH", async () => {
    await cliente().cancelarReserva(77);

    expect(ultima().url).toContain("/room/booking/77/cancel");
    expect(ultima().init.method).toBe("PATCH");
  });
});

describe("erros", () => {
  it("extrai o código de erro da Conexa", async () => {
    resposta = {
      status: 422,
      corpo: { error: "SIGNATURE_02", message: "WhatsApp not activated" },
    };

    await expect(cliente().obterCliente(1)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConexaApiError && e.codigo === "SIGNATURE_02",
    );
  });

  it("token recusado vira mensagem acionável no teste de conexão", async () => {
    resposta = { status: 401, corpo: { message: "Unauthorized" } };

    const r = await cliente().testar();

    expect(r.ok).toBe(false);
    expect(r.mensagem).toContain("administrador");
  });

  it("URL errada aponta o caminho da API", async () => {
    resposta = { status: 404, corpo: {} };

    const r = await cliente().testar();

    expect(r.mensagem).toContain("/index.php/api/v2");
  });
});

describe("resolver unidade e sala por nome", () => {
  it("acha a unidade pelo nome cadastrado", () => {
    expect(resolverUnidade("Natal", config).companyId).toBe(3);
    expect(resolverUnidade("recife", config).companyId).toBe(7);
  });

  it("aceita o id cru", () => {
    expect(resolverUnidade("7", config).companyId).toBe(7);
    expect(resolverUnidade(7, config).companyId).toBe(7);
  });

  it("sem termo, usa a primeira unidade", () => {
    // Instalação de uma unidade só não deve obrigar o agente a escolher.
    expect(resolverUnidade(undefined, config).companyId).toBe(3);
  });

  it("nome desconhecido devolve as opções, para o agente se corrigir", () => {
    const r = resolverUnidade("Fortaleza", config);

    expect(r.companyId).toBeUndefined();
    expect(r.nomes).toEqual(["Natal", "Recife"]);
  });

  it("sala segue a mesma regra, mas sem primeira por padrão", () => {
    // Reservar na sala errada por omissão é pior que pedir a sala.
    expect(resolverSala("Sala Executiva", config).roomId).toBe(4140);
    expect(resolverSala(undefined, config).roomId).toBeUndefined();
  });
});
