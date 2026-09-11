import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  CODIGO,
  decodificarValorDeCabecalho,
  INFO_DO_SERVIDOR,
  tratarMensagem,
  VERSOES_LEGADAS,
  VERSOES_MODERNAS,
  type Cabecalhos,
  type Executor,
} from "./protocolo";

const MODERNA = VERSOES_MODERNAS[0];

const executor: Executor = {
  listar: () => [
    {
      name: "listar_agentes",
      title: "Listar agentes",
      description: "Lista os agentes.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
  ],
  chamar: async (nome) => {
    if (nome === "listar_agentes") {
      return { texto: '{"agentes":[]}', estruturado: { agentes: [] } };
    }
    if (nome === "falha_de_execucao") {
      return { texto: "Não deu: motivo X.", erro: true };
    }
    if (nome === "estoura") throw new Error("boom com detalhe interno");
    return null;
  },
};

const semCabecalho: Cabecalhos = { versao: null, metodo: null, nome: null };

function metaModerno(extra: Record<string, unknown> = {}) {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERNA,
    "io.modelcontextprotocol/clientCapabilities": {},
    ...extra,
  };
}

function pedidoModerno(metodo: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: metodo,
    params: { ...params, _meta: metaModerno() },
  };
}

function cabecalhosModernos(metodo: string, nome: string | null = null): Cabecalhos {
  return { versao: MODERNA, metodo, nome };
}

describe("era moderna (2026-07-28): sem aperto de mão, metadados em toda requisição", () => {
  it("server/discover devolve versões, capacidades e identidade", async () => {
    const r = await tratarMensagem(
      pedidoModerno("server/discover"),
      cabecalhosModernos("server/discover"),
      executor,
    );
    expect(r.status).toBe(200);
    const result = (r.corpo as { result: Record<string, unknown> }).result;
    expect(result.resultType).toBe("complete");
    expect(result.supportedVersions).toContain(MODERNA);
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result._meta).toEqual({
      "io.modelcontextprotocol/serverInfo": INFO_DO_SERVIDOR,
    });
  });

  it("tools/list devolve as ferramentas com resultType", async () => {
    const r = await tratarMensagem(
      pedidoModerno("tools/list"),
      cabecalhosModernos("tools/list"),
      executor,
    );
    const result = (r.corpo as { result: { resultType: string; tools: unknown[] } }).result;
    expect(result.resultType).toBe("complete");
    expect(result.tools).toHaveLength(1);
  });

  it("tools/call devolve texto e estrutura", async () => {
    const r = await tratarMensagem(
      pedidoModerno("tools/call", { name: "listar_agentes", arguments: {} }),
      cabecalhosModernos("tools/call", "listar_agentes"),
      executor,
    );
    expect(r.status).toBe(200);
    const result = (r.corpo as { result: Record<string, unknown> }).result;
    expect(result.resultType).toBe("complete");
    expect(result.content).toEqual([{ type: "text", text: '{"agentes":[]}' }]);
    expect(result.structuredContent).toEqual({ agentes: [] });
    expect(result.isError).toBe(false);
  });

  it("erro de EXECUÇÃO vira isError, e não erro de protocolo", async () => {
    // A diferença importa: erro de execução chega ao modelo, que se corrige;
    // erro de protocolo o cliente pode engolir.
    const r = await tratarMensagem(
      pedidoModerno("tools/call", { name: "falha_de_execucao" }),
      cabecalhosModernos("tools/call", "falha_de_execucao"),
      executor,
    );
    const result = (r.corpo as { result: Record<string, unknown> }).result;
    expect(result.isError).toBe(true);
  });

  describe("cabeçalhos são conferidos contra o corpo", () => {
    it("sem MCP-Protocol-Version → 400 HeaderMismatch", async () => {
      const r = await tratarMensagem(
        pedidoModerno("tools/list"),
        { ...cabecalhosModernos("tools/list"), versao: null },
        executor,
      );
      expect(r.status).toBe(400);
      expect((r.corpo as { error: { code: number } }).error.code).toBe(CODIGO.CABECALHO_DIVERGENTE);
    });

    it("versão do cabeçalho diferente da do corpo → 400 HeaderMismatch", async () => {
      const r = await tratarMensagem(
        pedidoModerno("tools/list"),
        { ...cabecalhosModernos("tools/list"), versao: "2025-06-18" },
        executor,
      );
      expect(r.status).toBe(400);
      expect((r.corpo as { error: { code: number } }).error.code).toBe(CODIGO.CABECALHO_DIVERGENTE);
    });

    it("Mcp-Method diferente do método do corpo → 400", async () => {
      // O intermediário roteia pelo cabeçalho; executar o corpo seria executar
      // outra coisa que não a que passou pela porta.
      const r = await tratarMensagem(
        pedidoModerno("tools/call", { name: "listar_agentes" }),
        cabecalhosModernos("tools/list", "listar_agentes"),
        executor,
      );
      expect(r.status).toBe(400);
      expect((r.corpo as { error: { code: number } }).error.code).toBe(CODIGO.CABECALHO_DIVERGENTE);
    });

    it("Mcp-Name diferente da ferramenta do corpo → 400", async () => {
      const r = await tratarMensagem(
        pedidoModerno("tools/call", { name: "listar_agentes" }),
        cabecalhosModernos("tools/call", "aplicar_alteracao_de_prompt"),
        executor,
      );
      expect(r.status).toBe(400);
    });

    it("Mcp-Name em base64 sentinela é decodificado antes de comparar", async () => {
      const codificado = `=?base64?${Buffer.from("listar_agentes").toString("base64")}?=`;
      const r = await tratarMensagem(
        pedidoModerno("tools/call", { name: "listar_agentes" }),
        cabecalhosModernos("tools/call", codificado),
        executor,
      );
      expect(r.status).toBe(200);
    });
  });

  it("versão moderna desconhecida → 400 UnsupportedProtocolVersion com a lista", async () => {
    const pedido = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2099-01-01",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };
    const r = await tratarMensagem(
      pedido,
      { versao: "2099-01-01", metodo: "tools/list", nome: null },
      executor,
    );
    expect(r.status).toBe(400);
    const erro = (r.corpo as { error: { code: number; data: { supported: string[] } } }).error;
    expect(erro.code).toBe(CODIGO.VERSAO_NAO_SUPORTADA);
    expect(erro.data.supported).toContain(MODERNA);
  });

  it("sem clientCapabilities em _meta → 400 Invalid params", async () => {
    const pedido = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERNA } },
    };
    const r = await tratarMensagem(pedido, cabecalhosModernos("tools/list"), executor);
    expect(r.status).toBe(400);
    expect((r.corpo as { error: { code: number } }).error.code).toBe(CODIGO.PARAMETROS_INVALIDOS);
  });

  it("cabeçalho moderno com corpo sem _meta é erro moderno, não legado", async () => {
    // Tratar como legado esconderia do cliente que ele montou mal a requisição.
    const r = await tratarMensagem(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      cabecalhosModernos("tools/list"),
      executor,
    );
    expect(r.status).toBe(400);
    expect((r.corpo as { error: { code: number } }).error.code).toBe(CODIGO.PARAMETROS_INVALIDOS);
  });

  it("método desconhecido → 404 com -32601", async () => {
    const r = await tratarMensagem(
      pedidoModerno("resources/list"),
      cabecalhosModernos("resources/list"),
      executor,
    );
    expect(r.status).toBe(404);
    expect((r.corpo as { error: { code: number } }).error.code).toBe(CODIGO.METODO_INEXISTENTE);
  });
});

describe("era legada (initialize): o cliente que ainda fala 2025", () => {
  it("initialize devolve a MESMA versão quando suportada", async () => {
    const r = await tratarMensagem(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } },
      semCabecalho,
      executor,
    );
    expect(r.status).toBe(200);
    const result = (r.corpo as { result: Record<string, unknown> }).result;
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(result.serverInfo).toEqual(INFO_DO_SERVIDOR);
  });

  it("initialize com versão desconhecida devolve a legada mais recente", async () => {
    const r = await tratarMensagem(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1900-01-01" } },
      semCabecalho,
      executor,
    );
    const result = (r.corpo as { result: { protocolVersion: string } }).result;
    expect(result.protocolVersion).toBe(VERSOES_LEGADAS[0]);
  });

  it("notifications/initialized → 202 sem corpo", async () => {
    const r = await tratarMensagem(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { ...semCabecalho, versao: "2025-06-18" },
      executor,
    );
    expect(r).toEqual({ status: 202, corpo: null });
  });

  it("tools/list sem _meta funciona e NÃO traz resultType", async () => {
    const r = await tratarMensagem(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { ...semCabecalho, versao: "2025-06-18" },
      executor,
    );
    const result = (r.corpo as { result: Record<string, unknown> }).result;
    expect(result.tools).toHaveLength(1);
    expect(result).not.toHaveProperty("resultType");
  });

  it("sem cabeçalho de versão nenhum, assume 2025-03-26 e atende", async () => {
    const r = await tratarMensagem(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "listar_agentes" } },
      semCabecalho,
      executor,
    );
    expect(r.status).toBe(200);
    expect((r.corpo as { result: { isError: boolean } }).result.isError).toBe(false);
  });

  it("cabeçalho com versão legada desconhecida → 400", async () => {
    const r = await tratarMensagem(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { ...semCabecalho, versao: "2024-01-01" },
      executor,
    );
    expect(r.status).toBe(400);
  });
});

describe("robustez", () => {
  it("lote é recusado", async () => {
    const r = await tratarMensagem([{ jsonrpc: "2.0", id: 1, method: "ping" }], semCabecalho, executor);
    expect(r.status).toBe(400);
  });

  it("não-JSON-RPC é recusado", async () => {
    const r = await tratarMensagem({ foo: 1 }, semCabecalho, executor);
    expect(r.status).toBe(400);
  });

  it("ferramenta desconhecida é erro JSON-RPC -32602", async () => {
    const r = await tratarMensagem(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "excluir_tudo" } },
      semCabecalho,
      executor,
    );
    expect((r.corpo as { error: { code: number } }).error.code).toBe(CODIGO.PARAMETROS_INVALIDOS);
  });

  it("falha inesperada do executor vira -32603 SEM vazar a mensagem interna", async () => {
    const r = await tratarMensagem(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "estoura" } },
      semCabecalho,
      executor,
    );
    expect(r.status).toBe(500);
    const erro = (r.corpo as { error: { code: number; message: string } }).error;
    expect(erro.code).toBe(CODIGO.ERRO_INTERNO);
    expect(erro.message).not.toContain("boom");
  });

  it("decodificarValorDeCabecalho deixa valor comum intacto", () => {
    expect(decodificarValorDeCabecalho("listar_agentes")).toBe("listar_agentes");
  });
});
