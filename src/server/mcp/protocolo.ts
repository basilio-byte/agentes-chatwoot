import { Buffer } from "node:buffer";

/**
 * O protocolo MCP, sem Next e sem banco — puro e testado.
 *
 * ⚠ **Dual-era de propósito.** A revisão `2026-07-28` da especificação trocou o
 * aperto de mão (`initialize`) por metadados em CADA requisição (`_meta` com a
 * versão e as capacidades do cliente) e passou a exigir cabeçalhos espelhando o
 * corpo (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`). Um servidor só
 * moderno recusa o cliente que ainda fale a revisão anterior; um só legado
 * recusa o que já fala a nova. Atendendo as duas eras no mesmo endpoint, quem
 * conecta nunca precisa saber qual é — e a especificação chama exatamente isso
 * de servidor "dual-era".
 *
 * A era é escolhida pela FORMA da requisição, como a especificação manda:
 * `initialize` seleciona o legado; requisição com a versão em `_meta` é moderna.
 *
 * Sem sessão nas duas eras. O legado permite `Mcp-Session-Id` mas não exige, e
 * nada aqui precisa de estado entre chamadas: o token vem em toda requisição e
 * o papel de quem chama é relido a cada uma.
 */

export const VERSOES_MODERNAS = ["2026-07-28"] as const;
export const VERSOES_LEGADAS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const VERSOES_SUPORTADAS: readonly string[] = [
  ...VERSOES_MODERNAS,
  ...VERSOES_LEGADAS,
];

export const INFO_DO_SERVIDOR = {
  name: "seahub-agentes",
  title: "Seahub Agentes",
  version: "1.0.0",
} as const;

export const CODIGO = {
  PARSE: -32700,
  REQUISICAO_INVALIDA: -32600,
  METODO_INEXISTENTE: -32601,
  PARAMETROS_INVALIDOS: -32602,
  ERRO_INTERNO: -32603,
  /** Reservado pela especificação: cabeçalho ausente ou divergente do corpo. */
  CABECALHO_DIVERGENTE: -32020,
  /** Reservado pela especificação: versão de protocolo não suportada. */
  VERSAO_NAO_SUPORTADA: -32022,
} as const;

const CHAVE_VERSAO = "io.modelcontextprotocol/protocolVersion";
const CHAVE_CAPACIDADES = "io.modelcontextprotocol/clientCapabilities";
const CHAVE_INFO_DO_SERVIDOR = "io.modelcontextprotocol/serverInfo";

/**
 * O que o modelo do outro lado lê ao conectar. É a regra de uso desta
 * plataforma, escrita para quem vai operá-la — não documentação do protocolo.
 */
export const INSTRUCOES = [
  "Painel de gestão dos agentes de I.A. da Seahub Coworking, que atendem clientes reais no WhatsApp. Comece por listar_agentes.",
  "O que você pode fazer depende do papel da conta dona do token: Leitura só consulta; Administrador também altera.",
  "Toda alteração vale em produção na hora e fica registrada em nome da pessoa dona do token, marcada como feita pelo MCP.",
  "Prompt se altera em dois passos: propor_alteracao_de_prompt mostra a diferença; só depois de a pessoa aprovar explicitamente, aplicar_alteracao_de_prompt grava. Nunca aplique sem mostrar o diff e ouvir um sim.",
  "Antes de reescrever um prompt, confira as ferramentas reais do agente (ver_agente) e o formato dos parâmetros (ver_ferramenta): parâmetro com nome errado é descartado em silêncio pelo sistema e a ação sai pela metade.",
  "O sistema soma a todo prompt as Regras da Casa e a lista de colegas (ver_regras_injetadas); em conflito, as regras vencem. Não escreva no prompt nada que as contradiga.",
  "Datas vêm no horário de São Paulo; custos, em dólar.",
  "Não há como excluir nada, ler ou trocar credencial, gerar token de gatilho nem mexer em contas por aqui — de propósito.",
].join("\n");

export type AnotacoesDeFerramenta = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
};

export type FerramentaPublica = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: AnotacoesDeFerramenta;
};

export type ResultadoDeFerramenta = {
  /** Texto que o modelo lê. */
  texto: string;
  /** Mesmo conteúdo em objeto, para clientes que leem `structuredContent`. */
  estruturado?: Record<string, unknown>;
  /** Erro de EXECUÇÃO — o modelo lê e se corrige. Não é erro de protocolo. */
  erro?: boolean;
};

export type Executor = {
  /** Já filtrado pelo papel de quem chama. */
  listar(): FerramentaPublica[];
  /** `null` quando a ferramenta não existe para este papel. */
  chamar(nome: string, argumentos: unknown): Promise<ResultadoDeFerramenta | null>;
};

/** Os cabeçalhos que a especificação espelha do corpo. Nomes já resolvidos. */
export type Cabecalhos = {
  versao: string | null;
  metodo: string | null;
  nome: string | null;
};

/** `corpo: null` significa `202 Accepted` sem corpo. */
export type RespostaHttp = { status: number; corpo: unknown | null };

type Id = string | number;

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function erroRpc(
  status: number,
  id: Id | undefined,
  code: number,
  message: string,
  data?: unknown,
): RespostaHttp {
  return {
    status,
    corpo: {
      jsonrpc: "2.0",
      ...(id !== undefined ? { id } : {}),
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    },
  };
}

function resultado(id: Id, result: Record<string, unknown>): RespostaHttp {
  return { status: 200, corpo: { jsonrpc: "2.0", id, result } };
}

/**
 * Valor de cabeçalho no formato sentinela da especificação
 * (`=?base64?...?=`), usado quando o nome da ferramenta não cabe em ASCII puro.
 */
export function decodificarValorDeCabecalho(valor: string): string {
  const m = /^=\?base64\?(.*)\?=$/.exec(valor);
  if (!m) return valor;
  try {
    return Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return valor;
  }
}

/**
 * Trata UMA mensagem JSON-RPC recebida por POST.
 *
 * Nunca lança: falha de protocolo vira resposta de erro com o status HTTP que a
 * especificação pede, e falha inesperada do executor vira `-32603`.
 */
export async function tratarMensagem(
  corpo: unknown,
  cabecalhos: Cabecalhos,
  executor: Executor,
): Promise<RespostaHttp> {
  // Lote foi removido da especificação em 2025-06-18 e não voltou.
  if (Array.isArray(corpo)) {
    return erroRpc(400, undefined, CODIGO.REQUISICAO_INVALIDA, "Lote de mensagens não é suportado: envie uma mensagem por requisição.");
  }
  if (!ehObjeto(corpo) || corpo.jsonrpc !== "2.0") {
    return erroRpc(400, undefined, CODIGO.REQUISICAO_INVALIDA, "Mensagem JSON-RPC 2.0 inválida.");
  }

  const metodo = typeof corpo.method === "string" ? corpo.method : null;
  const temId = "id" in corpo;

  if (!metodo) {
    // Resposta do cliente a um pedido nosso. Não fazemos pedidos ao cliente,
    // mas o legado permite a mensagem, e aceitar custa nada.
    if (temId && ("result" in corpo || "error" in corpo)) {
      return { status: 202, corpo: null };
    }
    return erroRpc(400, undefined, CODIGO.REQUISICAO_INVALIDA, "Mensagem sem método.");
  }

  // Notificação (`notifications/initialized`, `notifications/cancelled`...):
  // nenhuma exige ação num servidor sem estado.
  if (!temId) return { status: 202, corpo: null };

  const id = corpo.id;
  if (typeof id !== "string" && typeof id !== "number") {
    return erroRpc(400, undefined, CODIGO.REQUISICAO_INVALIDA, "O id da requisição precisa ser texto ou número.");
  }

  const params = ehObjeto(corpo.params) ? corpo.params : {};

  try {
    if (metodo === "initialize") return inicializarLegado(id, params);

    const meta = ehObjeto(params._meta) ? params._meta : null;
    const versaoDoCorpo =
      meta && typeof meta[CHAVE_VERSAO] === "string"
        ? (meta[CHAVE_VERSAO] as string)
        : null;

    if (versaoDoCorpo) {
      return await moderno(id, metodo, params, meta!, versaoDoCorpo, cabecalhos, executor);
    }

    // Cabeçalho de versão moderna sem `_meta` no corpo: é requisição moderna
    // malformada, não legado. Tratá-la como legado mascararia o erro do cliente.
    if (
      cabecalhos.versao &&
      (VERSOES_MODERNAS as readonly string[]).includes(cabecalhos.versao)
    ) {
      return erroRpc(400, id, CODIGO.PARAMETROS_INVALIDOS, `A versão ${cabecalhos.versao} exige _meta com "${CHAVE_VERSAO}" e "${CHAVE_CAPACIDADES}" em toda requisição.`);
    }

    return await legado(id, metodo, params, cabecalhos, executor);
  } catch {
    return erroRpc(500, id, CODIGO.ERRO_INTERNO, "Falha interna do servidor MCP.");
  }
}

function inicializarLegado(id: Id, params: Record<string, unknown>): RespostaHttp {
  const pedida =
    typeof params.protocolVersion === "string" ? params.protocolVersion : null;

  // Suportando a versão pedida, a especificação manda devolver a MESMA; senão,
  // a mais recente que o servidor fala — e o cliente decide se continua.
  const versao =
    pedida && (VERSOES_LEGADAS as readonly string[]).includes(pedida)
      ? pedida
      : VERSOES_LEGADAS[0];

  return resultado(id, {
    protocolVersion: versao,
    capabilities: { tools: { listChanged: false } },
    serverInfo: INFO_DO_SERVIDOR,
    instructions: INSTRUCOES,
  });
}

async function moderno(
  id: Id,
  metodo: string,
  params: Record<string, unknown>,
  meta: Record<string, unknown>,
  versao: string,
  cabecalhos: Cabecalhos,
  executor: Executor,
): Promise<RespostaHttp> {
  // A ordem das checagens segue a especificação: cabeçalho ↔ corpo primeiro,
  // porque um intermediário pode ter roteado pelo cabeçalho e o servidor não
  // pode executar outra coisa com base no corpo.
  if (!cabecalhos.versao) {
    return erroRpc(400, id, CODIGO.CABECALHO_DIVERGENTE, "Falta o cabeçalho MCP-Protocol-Version.");
  }
  if (cabecalhos.versao !== versao) {
    return erroRpc(400, id, CODIGO.CABECALHO_DIVERGENTE, `O cabeçalho MCP-Protocol-Version (${cabecalhos.versao}) não confere com a versão do corpo (${versao}).`);
  }
  if (!(VERSOES_MODERNAS as readonly string[]).includes(versao)) {
    return erroRpc(400, id, CODIGO.VERSAO_NAO_SUPORTADA, "Unsupported protocol version", {
      supported: VERSOES_SUPORTADAS,
      requested: versao,
    });
  }
  if (!ehObjeto(meta[CHAVE_CAPACIDADES])) {
    return erroRpc(400, id, CODIGO.PARAMETROS_INVALIDOS, `Falta "${CHAVE_CAPACIDADES}" em _meta.`);
  }
  if (!cabecalhos.metodo) {
    return erroRpc(400, id, CODIGO.CABECALHO_DIVERGENTE, "Falta o cabeçalho Mcp-Method.");
  }
  if (cabecalhos.metodo !== metodo) {
    return erroRpc(400, id, CODIGO.CABECALHO_DIVERGENTE, `O cabeçalho Mcp-Method (${cabecalhos.metodo}) não confere com o método do corpo (${metodo}).`);
  }

  const metaDaResposta = { [CHAVE_INFO_DO_SERVIDOR]: INFO_DO_SERVIDOR };

  switch (metodo) {
    case "server/discover":
      return resultado(id, {
        resultType: "complete",
        supportedVersions: VERSOES_SUPORTADAS,
        capabilities: { tools: {} },
        _meta: metaDaResposta,
        instructions: INSTRUCOES,
      });

    case "tools/list":
      return resultado(id, {
        resultType: "complete",
        tools: executor.listar(),
        _meta: metaDaResposta,
      });

    case "tools/call": {
      const nome = typeof params.name === "string" ? params.name : null;
      if (!nome) {
        return erroRpc(400, id, CODIGO.PARAMETROS_INVALIDOS, "tools/call sem o nome da ferramenta.");
      }
      if (!cabecalhos.nome) {
        return erroRpc(400, id, CODIGO.CABECALHO_DIVERGENTE, "Falta o cabeçalho Mcp-Name.");
      }
      const nomeDoCabecalho = decodificarValorDeCabecalho(cabecalhos.nome);
      if (nomeDoCabecalho !== nome) {
        return erroRpc(400, id, CODIGO.CABECALHO_DIVERGENTE, `O cabeçalho Mcp-Name (${nomeDoCabecalho}) não confere com a ferramenta do corpo (${nome}).`);
      }
      return chamar(id, nome, params.arguments, executor, true, metaDaResposta);
    }

    case "ping":
      return resultado(id, { resultType: "complete", _meta: metaDaResposta });

    default:
      return erroRpc(404, id, CODIGO.METODO_INEXISTENTE, `Método não implementado: ${metodo}`);
  }
}

async function legado(
  id: Id,
  metodo: string,
  params: Record<string, unknown>,
  cabecalhos: Cabecalhos,
  executor: Executor,
): Promise<RespostaHttp> {
  // Ausente, a especificação manda assumir 2025-03-26 — que suportamos. Presente
  // e desconhecido, é 400.
  if (
    cabecalhos.versao &&
    !(VERSOES_LEGADAS as readonly string[]).includes(cabecalhos.versao)
  ) {
    return erroRpc(400, id, CODIGO.REQUISICAO_INVALIDA, `Versão de protocolo não suportada: ${cabecalhos.versao}.`, {
      supported: VERSOES_SUPORTADAS,
      requested: cabecalhos.versao,
    });
  }

  switch (metodo) {
    case "tools/list":
      return resultado(id, { tools: executor.listar() });

    case "tools/call": {
      const nome = typeof params.name === "string" ? params.name : null;
      if (!nome) {
        return erroRpc(200, id, CODIGO.PARAMETROS_INVALIDOS, "tools/call sem o nome da ferramenta.");
      }
      return chamar(id, nome, params.arguments, executor, false);
    }

    case "ping":
      return resultado(id, {});

    default:
      return erroRpc(200, id, CODIGO.METODO_INEXISTENTE, `Método não implementado: ${metodo}`);
  }
}

async function chamar(
  id: Id,
  nome: string,
  argumentos: unknown,
  executor: Executor,
  ehModerno: boolean,
  metaDaResposta?: Record<string, unknown>,
): Promise<RespostaHttp> {
  const saida = await executor.chamar(nome, argumentos ?? {});

  if (!saida) {
    return erroRpc(200, id, CODIGO.PARAMETROS_INVALIDOS, `Ferramenta desconhecida: ${nome}`);
  }

  return resultado(id, {
    ...(ehModerno ? { resultType: "complete" } : {}),
    content: [{ type: "text", text: saida.texto }],
    ...(saida.estruturado ? { structuredContent: saida.estruturado } : {}),
    isError: Boolean(saida.erro),
    ...(ehModerno && metaDaResposta ? { _meta: metaDaResposta } : {}),
  });
}
