import type { ConexaConfig } from "./config";

export class ConexaApiError extends Error {
  constructor(
    readonly status: number,
    readonly corpo: string,
    /** Código de erro da Conexa, quando ela manda um (ex.: `SIGNATURE_02`). */
    readonly codigo?: string,
  ) {
    super(`Conexa respondeu ${status}: ${corpo}`);
    this.name = "ConexaApiError";
  }
}

/**
 * Paginação nova da API do Conexa.
 *
 * ⚠ `limit` é **obrigatório**. Sem ele a API cai no modelo antigo de paginação,
 * que a Conexa descontinua em **01/08/2026** — omitir o parâmetro é uma quebra
 * com data marcada, não um detalhe de estilo. Por isso ele nunca é opcional
 * aqui dentro, e há teste travando isso.
 */
const LIMITE_PADRAO = 50;

export type Pagina<T> = {
  itens: T[];
  /** A Conexa diz se há mais registros; não devolve total confiável. */
  temMais: boolean;
};

type Filtros = Record<string, unknown>;

export class ConexaClient {
  constructor(
    private readonly config: ConexaConfig,
    private readonly token: string,
  ) {}

  private url(caminho: string, filtros?: Filtros) {
    const base = this.config.baseUrl.replace(/\/$/, "");
    const url = new URL(`${base}${caminho}`);

    for (const [chave, valor] of Object.entries(filtros ?? {})) {
      if (valor === undefined || valor === null || valor === "") continue;
      // Arrays vão em UM parâmetro, separados por vírgula (`id[]=1,2`) — não
      // repetindo a chave, que é como a maioria das APIs faz.
      url.searchParams.set(chave, Array.isArray(valor) ? valor.join(",") : String(valor));
    }

    return url.toString();
  }

  private async requisitar<T>(
    caminho: string,
    init: RequestInit = {},
    filtros?: Filtros,
  ): Promise<T> {
    const resposta = await fetch(this.url(caminho, filtros), {
      ...init,
      headers: {
        // Token permanente de API, no mesmo header do JWT de POST /auth.
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => "");
      throw new ConexaApiError(resposta.status, corpo.slice(0, 400), codigoDoErro(corpo));
    }

    if (resposta.status === 204) return undefined as T;
    return (await resposta.json()) as T;
  }

  private async listar<T>(
    caminho: string,
    filtros: Filtros = {},
  ): Promise<Pagina<T>> {
    const resposta = await this.requisitar<{
      data?: T[];
      pagination?: { hasNext?: boolean };
    }>(caminho, {}, { ...filtros, limit: filtros.limit ?? LIMITE_PADRAO });

    return {
      itens: resposta.data ?? [],
      temMais: Boolean(resposta.pagination?.hasNext),
    };
  }

  private post<T>(caminho: string, corpo: unknown) {
    return this.requisitar<T>(caminho, {
      method: "POST",
      body: JSON.stringify(corpo),
    });
  }

  private patch<T>(caminho: string, corpo: unknown) {
    return this.requisitar<T>(caminho, {
      method: "PATCH",
      body: JSON.stringify(corpo),
    });
  }

  // ─── Clientes ────────────────────────────────────────────────────────────

  buscarClientes(filtros: {
    companyId?: number;
    name?: string;
    cpf?: string;
    cnpj?: string;
    isActive?: 0 | 1;
    limit?: number;
    offset?: number;
  }) {
    const { companyId, ...resto } = filtros;
    return this.listar<Record<string, unknown>>("/customers", {
      ...resto,
      "companyId[]": companyId,
    });
  }

  obterCliente(id: number) {
    return this.requisitar<Record<string, unknown>>(`/customer/${id}`);
  }

  criarCliente(dados: Record<string, unknown>) {
    return this.post<{ id: number }>("/customer", dados);
  }

  atualizarCliente(id: number, dados: Record<string, unknown>) {
    return this.patch<{ id: number }>(`/customer/${id}`, dados);
  }

  // ─── Pessoas (signatários e solicitantes de reserva) ─────────────────────

  listarPessoas(filtros: { customerId?: number; name?: string; cpf?: string; limit?: number }) {
    const { customerId, ...resto } = filtros;
    return this.listar<Record<string, unknown>>("/persons", {
      ...resto,
      "customerId[]": customerId,
    });
  }

  criarPessoa(dados: Record<string, unknown>) {
    return this.post<{ id: number }>("/person", dados);
  }

  // ─── Planos e produtos ───────────────────────────────────────────────────

  listarPlanos(filtros: { companyId?: number; name?: string; isActive?: 0 | 1; limit?: number }) {
    const { companyId, ...resto } = filtros;
    return this.listar<Record<string, unknown>>("/plans", {
      ...resto,
      "companyId[]": companyId,
    });
  }

  obterPlano(id: number) {
    return this.requisitar<Record<string, unknown>>(`/plan/${id}`);
  }

  listarProdutos(filtros: { companyId?: number; name?: string; isActive?: 0 | 1; limit?: number }) {
    const { companyId, ...resto } = filtros;
    return this.listar<Record<string, unknown>>("/products", {
      ...resto,
      "companyId[]": companyId,
    });
  }

  // ─── Contratos ───────────────────────────────────────────────────────────

  /**
   * `sellerId` entra aqui, não no prompt: com API Token não há usuário logado e
   * a Conexa exige o vendedor explícito. Sem ele a venda nasce órfã.
   */
  criarContrato(dados: Record<string, unknown>) {
    return this.post<{ id: number }>("/contract", {
      ...(this.config.sellerId ? { sellerId: this.config.sellerId } : {}),
      ...dados,
    });
  }

  obterContrato(id: number) {
    return this.requisitar<Record<string, unknown>>(`/contract/${id}`);
  }

  listarContratos(filtros: {
    companyId?: number;
    customerId?: number;
    isActive?: 0 | 1;
    limit?: number;
  }) {
    const { companyId, customerId, ...resto } = filtros;
    return this.listar<Record<string, unknown>>("/contracts", {
      ...resto,
      "companyId[]": companyId,
      "customerId[]": customerId,
    });
  }

  /**
   * Manda o contrato para assinatura eletrônica (D4Sign, por dentro do Conexa).
   *
   * `deliveryMethod: "whatsapp"` entrega no número do cliente — é o que permite
   * fechar a venda dentro da própria conversa, sem e-mail no caminho.
   */
  solicitarAssinatura(
    contratoId: number,
    dados: {
      contractTemplateId: number;
      customerSigners: {
        name: string;
        deliveryMethod: "email" | "whatsapp";
        deliveryValue: string;
        role: string;
      }[];
      companySigners?: {
        deliveryMethod: "email" | "whatsapp";
        deliveryValue: string;
        role: string;
      }[];
      contractNumber?: string;
    },
  ) {
    return this.post<Record<string, unknown>>(
      `/contract/${contratoId}/signature/request`,
      dados,
    );
  }

  encerrarContrato(id: number, dados: Record<string, unknown>) {
    return this.patch<Record<string, unknown>>(`/contract/end/${id}`, dados);
  }

  // ─── Cobrança e pagamento ────────────────────────────────────────────────

  criarCobranca(dados: {
    salesIds: number[];
    invoicingMethodId?: number;
    dueDate?: string;
    notes?: string;
  }) {
    return this.post<{ id: number }>("/charge", dados);
  }

  obterCobranca(id: number) {
    return this.requisitar<Record<string, unknown>>(`/charge/${id}`);
  }

  listarCobrancas(filtros: {
    companyId?: number;
    customerId?: number;
    status?: string;
    limit?: number;
  }) {
    const { companyId, customerId, ...resto } = filtros;
    return this.listar<Record<string, unknown>>("/charges", {
      ...resto,
      "companyId[]": companyId,
      "customerId[]": customerId,
    });
  }

  /**
   * Pix da cobrança: código copia-e-cola e QR em base64.
   *
   * A Conexa recomenda consultar **sempre antes de exibir** — depois do
   * vencimento ela regenera o Pix com juros e multa e estende a validade. Um
   * código guardado por nós viraria um valor errado na mão do cliente.
   */
  obterPix(cobrancaId: number) {
    return this.requisitar<{ copyPasteCode?: string; qrCode?: string }>(
      `/charge/pix/${cobrancaId}`,
    );
  }

  listarMeiosDePagamento(filtros: { isActive?: 0 | 1; limit?: number } = {}) {
    return this.listar<Record<string, unknown>>("/paymentMethods", filtros);
  }

  listarMeiosDeFaturamento(filtros: { companyId?: number; limit?: number } = {}) {
    const { companyId, ...resto } = filtros;
    return this.listar<Record<string, unknown>>("/invoicingMethods", {
      ...resto,
      "companyId[]": companyId,
    });
  }

  // ─── Vendas ──────────────────────────────────────────────────────────────

  criarVenda(dados: Record<string, unknown>) {
    return this.post<{ id: number }>("/sale", {
      ...(this.config.sellerId ? { sellerId: this.config.sellerId } : {}),
      ...dados,
    });
  }

  obterVenda(id: number) {
    return this.requisitar<Record<string, unknown>>(`/sale/${id}`);
  }

  listarVendas(filtros: { customerId?: number; status?: string; limit?: number }) {
    const { customerId, ...resto } = filtros;
    return this.listar<Record<string, unknown>>("/sales", {
      ...resto,
      "customerId[]": customerId,
    });
  }

  // ─── Reservas de sala (Conexa Coworking) ─────────────────────────────────

  criarReserva(dados: {
    customerId: number;
    personId?: number;
    roomId: number;
    date: string;
    startTime: string;
    finalTime: string;
    notes?: string;
    sendCustomerEmail?: boolean;
  }) {
    return this.post<{ id: number }>("/room/booking", dados);
  }

  obterReserva(id: number) {
    return this.requisitar<Record<string, unknown>>(`/room/booking/${id}`);
  }

  /**
   * Também é como se descobre disponibilidade: não existe endpoint de horários
   * livres, então listamos o que já está ocupado na sala e na data.
   */
  listarReservas(filtros: {
    companyId?: number;
    customerId?: number;
    roomId?: number;
    status?: string;
    bookingDateTimeFrom?: string;
    bookingDateTimeTo?: string;
    limit?: number;
  }) {
    const { companyId, customerId, roomId, ...resto } = filtros;
    return this.listar<Record<string, unknown>>("/room/bookings", {
      ...resto,
      "companyId[]": companyId,
      "customerId[]": customerId,
      "roomId[]": roomId,
    });
  }

  alterarReserva(id: number, dados: Record<string, unknown>) {
    return this.patch<Record<string, unknown>>(`/room/booking/${id}`, dados);
  }

  cancelarReserva(id: number, dados: Record<string, unknown> = {}) {
    return this.patch<Record<string, unknown>>(`/room/booking/${id}/cancel`, dados);
  }

  // ─── Apoio ───────────────────────────────────────────────────────────────

  listarUnidades(filtros: { active?: 0 | 1; limit?: number } = {}) {
    return this.listar<Record<string, unknown>>("/companies", filtros);
  }

  registrarLead(dados: Record<string, unknown>) {
    return this.post<{ id: number }>("/potentialCustomer", dados);
  }

  /**
   * Confere credencial e URL.
   *
   * Usa `GET /companies`, que toda instância tem e todo token consegue ler —
   * e de quebra devolve as unidades, que é o que o operador precisa cadastrar.
   */
  async testar(): Promise<{ ok: boolean; mensagem: string }> {
    try {
      const { itens } = await this.listarUnidades({ limit: 20 });
      const nomes = itens
        .map((u) => String(u.tradeName ?? u.legalName ?? u.id))
        .slice(0, 5);

      return {
        ok: true,
        mensagem: nomes.length
          ? `Conexão bem-sucedida. Unidades encontradas: ${nomes.join(", ")}.`
          : "Conexão bem-sucedida, mas nenhuma unidade foi retornada.",
      };
    } catch (erro) {
      if (!(erro instanceof ConexaApiError)) {
        return {
          ok: false,
          mensagem:
            erro instanceof Error
              ? `Falha de rede: ${erro.message}`
              : "Falha desconhecida.",
        };
      }
      if (erro.status === 401 || erro.status === 403) {
        return {
          ok: false,
          mensagem:
            "Token recusado. Confira se é um token de API criado por um administrador do Conexa, e se não expirou.",
        };
      }
      if (erro.status === 404) {
        return {
          ok: false,
          mensagem:
            "Não encontrado. Confira a URL — ela precisa terminar em /index.php/api/v2.",
        };
      }
      return { ok: false, mensagem: `Conexa respondeu ${erro.status}.` };
    }
  }
}

/** A Conexa devolve códigos como `SIGNATURE_02` — vale mais que o texto. */
function codigoDoErro(corpo: string): string | undefined {
  const achado = corpo.match(/[A-Z]+_\d{2}/);
  return achado?.[0];
}
